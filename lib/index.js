
/**
 * Module dependencies.
 */

var Identify = require('segmentio-facade').Identify;
var integration = require('segmentio-integration');
var isostring = require('isostring');
var hash = require('string-hash');
var mapper = require('./mapper');
var time = require('unix-time');
var extend = require('extend');
var dot = require('obj-case');
var Batch = require('batch');
var tick = setImmediate;
var is = require('is');

/**
 * Expose `Intercom`
 */

var Intercom = module.exports = integration('Intercom')
  .endpoint('https://api-segment.intercom.io')
  .ensure('settings.apiKey')
  .ensure('settings.appId')
  .channels(['server']);

/**
 * Ensure userId or email.
 */

Intercom.ensure(function(msg){
  var email = msg.proxy('traits.email') || msg.proxy('properties.email');
  var user = msg.userId();
  if (!(email || user)) {
    return this.invalid(".userId or .email is required");
  }
});

/**
 * Identify a user in intercom
 *
 * https://doc.intercom.io/api/#create-or-update-user
 *
 * @param {Identify} identify
 * @param {Function} fn
 * @api public
 */

Intercom.prototype.identify = function(identify, fn){
  var id = identify.userId() || identify.email();
  var key = [this.settings.appId, id].join(':');
  var self = this;
  var options = this.settings;

  this.lock(key, function(err){
    if (err) return fn(err);
    return self
      .post('/users')
      .set(headers(identify, self.settings))
      .type('json')
      .accept('json')
      .send(mapper.identify(identify, options))
      .end(self.handle(function(err, res){
        self.unlock(key, function(){
          fn(err, res);
        });
      }));
  });
};

/**
 * Group in two steps - company and then user
 *
 * @param {Group} group
 * @param {Function} fn
 * @api public
 */

Intercom.prototype.group = function(group, fn){
  var json = group.json();
  var traits = json.traits || {};
  var self = this;
  var options = this.settings;

  return this
    .post('/companies')
    .set(headers(group, this.settings))
    .type('json')
    .accept('json')
    .send(mapper.group(group, options))
    .end(this.handle(function(err){
        if (err) return fn(err);
        json.userId = group.userId();
        traits.id = group.groupId();
        json.traits = { companies: [traits] };
        var identify = new Identify(json);
        self.identify(identify, fn);
      })
    );
};

/**
 * Track the user's action
 *
 * @param {Track} track
 * @param {Function} fn
 * @api public
 */

Intercom.prototype.track = function(track, fn) {
  var options = this.settings;

  return this
    .post('/events')
    .set(headers(track, this.settings))
    .type('json')
    .accept('json')
    .send(mapper.track(track, options))
    .end(this.handle(fn));
};

/**
 * Format all the traits which are dates for intercoms format
 *
 * @param {Object} traits
 * @return {Object}
 * @api private
 */

Intercom.prototype.formatTraits = function(traits){
  var output = {};

  Object.keys(traits).forEach(function(key){
    var val = traits[key];
    if (isostring(val) || is.date(val)) {
      val = time(val);
      key = dateKey(key);
    }

    output[key] = val;
  });

  return output;
};

/**
 * Set up a key with the dates for intercom
 *
 * http://docs.intercom.io/#CustomDataDates
 *
 * @param {String} key
 * @return {String}
 * @api private
 */

function dateKey (key) {
  if (endswith(key, '_at')) return key;
  if (endswith(key, ' at')) return key.substr(0, key.length - 3) + '_at';
  return key + '_at';
}

/**
 * Test whether a string ends with the suffix
 *
 * @param {String} str
 * @param {String} suffix
 * @return {String}
 * @api private
 */

function endswith (str, suffix) {
  str = str.toLowerCase();
  return str.substr(str.length - suffix.length) === suffix;
}

/**
 * Add headers
 *
 * @param {Facade} message
 * @return {Object}
 * @api private
 */

function headers (message, settings) {
  var buf = new Buffer(settings.appId + ':' + settings.apiKey);
  var auth = 'Basic ' + buf.toString('base64');
  return {
    Authorization: auth,
    'User-Agent': 'Segment.io/1.0.0'
  };
}