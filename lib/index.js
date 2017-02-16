
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
var fmt = require('@segment/fmt');

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
 * Group call: upsert company data for users via Intercom Bulk User API
 * Even though this is not explicitly an endpoint for their `/companies` resource,
 * we can send `companies` object via Bulk User API (recommended by Intercom directly)
 *
 * https://developers.intercom.com/reference#bulk-user-operations
 *
 * To preserve as much order as possible for multiple `.group()` calls for a given userId we will:
 *
 * 1) Lookup in redis if there is an existing job for a `userId`
 * 2) If exists, add to the job
 * 3) Otherwise create a new job, save jobId in redis with expiration
 * 4) Error handle in case we try to add to an invalid job
 *
 * @param {Group} group
 * @param {Function} fn
 * @api public
 */

Intercom.prototype.group = function(group, fn){
  var traits = group.traits();
  var id = group.userId() || group.email();
  // We are locking separately from `.identify()` calls by adding 'groups'
  // Since both endpoints are upsertions so race condition does not matter.
  // If there is no profile yet for this message's userId, it will create it under
  // the ensured `userId` field, and a later `.identify()` call with the user's traits will be updated
  var key = [this.settings.appId, 'groups', id].join(':');
  var self = this;

  this.lock(key, function(err){
    if (err) return fn(err);
    var redis = self.redis();
    var jobKey = [self.settings.appId, 'jobs', 'users', id].join(':');

    redis.get(jobKey, function(err, jobId){
      if (err) {
        return self.unlock(key, function(){
          return fn(err);
        });
      }

      if (jobId) {
        self.addToExisting(jobId, group, key, fn);
      } else {
        self.createNewJob(group, key, fn);
      }
    });
  });
};

/**
 * Track the user's action via Bulk Event API
 *
 * https://developers.intercom.com/reference#bulk-event-operations
 *
 * 1) Lookup in redis if there is an existing job for a `userId`
 * 2) If exists, add to the job
 * 3) Otherwise create a new job, save jobId in redis with expiration
 * 4) Error handle in case we try to add to an invalid job
 *
 * Note: Jobs stay open for 15 minutes but messages are processed right away
 *
 * @param {Track} track
 * @param {Function} fn
 * @api public
 */

Intercom.prototype.track = function(event, fn){
  var id = event.userId() || event.email();
  // We are locking with the same key as `.identify()` calls to ensure that
  // as long as we receive `.identify()` first, we won't have race condition issues
  // with `.track()` calls
  var key = [this.settings.appId, id].join(':');
  var self = this;

  this.lock(key, function(err){
    if (err) return fn(err);
    var redis = self.redis();
    var jobKey = [self.settings.appId, 'jobs', 'events', id].join(':');

    // Check redis for existing job since we don't want to create
    // a new job per event
    redis.get(jobKey, function(err, jobId){
      if (err) {
        return self.unlock(key, function(){
          return fn(err);
        });
      }

      if (jobId) {
        self.addToExisting(jobId, event, key, fn);
      } else {
        self.createNewJob(event, key, fn);
      }
    });
  });
};

/**
 * Make a request to add to an existing Bulk Job and then unlock
 *
 * https://developers.intercom.com/reference#adding-to-a-bulk-job
 *
 * @api private
 * @param {String} jobId
 * @param {String} key
 * @param {Facade} msg
 * @param {Function} fn
 */

Intercom.prototype.addToExisting = function(jobId, msg, key, fn){
  var self = this;
  var dataType = (msg.action() === 'track') ? 'events' : 'users';
  var endpoint = fmt('/bulk/%s', dataType);
  var data = mapper[msg.action()](msg, this.settings);
  data.job = { id: jobId };

  return this
    .post(endpoint)
    .set(headers(msg, this.settings))
    .type('json')
    .accept('json')
    .send(data)
    .end(self.handle(function(err, res){
      // If for some reason we couldn't add to an existing job,
      // just create a new one & store in redis
      if (err) return self.createNewJob(msg, key, fn);

      self.unlock(key, function(){
        return fn(err, res);
      });
    }));
};

/**
 * Make a request to create a new Bulk Job
 * Store jobId in redis and set expiration
 *
 * https://developers.intercom.com/reference#bulk-apis
 *
 * @api private
 * @param {Facade} msg
 * @param {String} key
 * @param {Function} fn
 */

Intercom.prototype.createNewJob = function(msg, key, fn){
  var self = this
  var id = msg.userId() || msg.email();
  var dataType = (msg.action() === 'track') ? 'events' : 'users';
  var endpoint = fmt('/bulk/%s', dataType);
  var jobKey = [this.settings.appId, 'jobs', dataType, id].join(':');

  return this
    .post(endpoint)
    .set(headers(msg, this.settings))
    .type('json')
    .accept('json')
    .send(mapper[msg.action()](msg, self.settings))
    .end(self.handle(function(err, res){
      if (err) {
        return self.unlock(key, function(){
          return fn(err, res);
        });
      }
      // Store jobId in redis
      // Set expiration to 14.75 mins since Intercom keeps
      // jobs open for 15 minutes, we want to add a buffer for more reliability && higher success rate
      // Note: We're not passing 'NX' when storing in redis so we can overwrite over the same `jobKey`
      // since we just create a new job if we fail to an existing job despite jobKey not expiring yet.
      // So we need to be able to update the `closing_at` for the same jobKey since it is now a new job
      var job = res.body;
      var expiration = Date.now() - job.closing_at - 15000;

      self.redis().set(jobKey, job.id, 'PX', expiration, function(fail, ok){
        // return original success response from Intercom Bulk API for better tests
        self.unlock(key, function(){
          return fn(err, res);
        });
      });
    }));
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
