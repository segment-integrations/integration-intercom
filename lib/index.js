
/**
 * Module dependencies.
 */

var Identify = require('segmentio-facade').Identify;
var integration = require('segmentio-integration');
var isostring = require('isostring');
var hash = require('string-hash');
var mapperV2 = require('./mapper-v2');
var mapperV1 = require('./mapper-v1');
var time = require('unix-time');
var extend = require('extend');
var dot = require('obj-case');
var tick = setImmediate;
var is = require('is');
var fmt = require('@segment/fmt');
var Stats = require('dog-statsy');


// FIXME: temp metrics versions
var STATS = new Stats({
  host: '172.17.42.1',
  port: 8125,
  prefix: 'intercom'
});

/**
 * Expose `Intercom`
 */

var Intercom = module.exports = integration('Intercom')
  .endpoint('https://api-segment.intercom.io')
  .ensure(function(msg, settings){
    if (oauthTokenExists(settings.oauth)) return;
    if (settings.apiKey && settings.appId) return;
    return this.invalid('.apiKey and .appId is required if .oauth[\'access-token\'] is absent');
  })
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

Intercom.prototype.initialize =
    function() {
  this.userAgent = 'Segment.io/1.0.0';
  // Intercom asked us to split some users on the old version to help with load
  if (this.settings.isBulkAPIEnabled) {
    this.identify = this.identifyV2;
    this.track = this.trackV2;
    this.group = this.groupV2;
  } else {
    this.identify = this.identifyV1;
    this.track = this.trackV1;
    this.group = this.groupV1;
  }
};


/**
 * Identify a user in intercom
 *
 * https://doc.intercom.io/api/#create-or-update-user
 *
 * @param {Identify} identify
 * @param {Function} fn
 * @api public
 */

Intercom.prototype.identifyV2 = function(identify, fn) {
  // custom metric
  STATS.incr('called', 1, ['method:identify', 'version:2']);
  var id = identify.userId() || identify.email();
  var key = [this.settings.appId, id].join(':');
  var self = this;
  var options = this.settings;

  this.lock(key, function(err) {
    if (err) {
      return fn(err);
    }

    var req = function() {
      self.post('/users')
          .set(self.headers())
          .type('json')
          .accept('json')
          .send(mapperV2.identify(identify, options))
          .end(function(err, res) {
            self.unlock(key, function() {
              if (err && err.timeout) {
                return fn(err)
              }

              self.setLimit(res.headers, function() {
                fn(err, res);
              });
            });
          });
    };

    self.limit(req, fn);
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

Intercom.prototype.groupV2 = function(group, fn){
  // custom metric
  STATS.incr('called', 1, ['method:group', 'version:2']);
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

Intercom.prototype.trackV2 = function(event, fn){
  // custom metric
  STATS.incr('called', 1, ['method:track', 'version:2']);
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

Intercom.prototype.addToExisting = function(jobId, msg, key, fn) {
  var self = this;
  var dataType = (msg.action() === 'track') ? 'events' : 'users';
  var endpoint = fmt('/bulk/%s', dataType);
  var data = mapperV2[msg.action()](msg, this.settings);
  data.job = {id: jobId};

  var req = function() {
    self.post(endpoint)
        .set(self.headers())
        .type('json')
        .accept('json')
        .send(data)
        .end(self.handle(function(err, res) {
          if (err && err.timeout) {
            return self.unlock(key, function() {
              fn(err, res);
            });
          }

          self.setLimit(res.headers, function() {
            // If for some reason we couldn't add to an existing job,
            // just create a new one & store in redis
            if (err) {
              return self.createNewJob(msg, key, fn);
            }

            self.unlock(key, function() {
              fn(err, res);
            });
          });
        }));
  };

  self.limit(req, fn);
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

Intercom.prototype.createNewJob = function(msg, key, fn) {
  var self = this;
  var id = msg.userId() || msg.email();
  var dataType = (msg.action() === 'track') ? 'events' : 'users';
  var endpoint = fmt('/bulk/%s', dataType);
  var jobKey = [this.settings.appId, 'jobs', dataType, id].join(':');

  var req = function() {
    self.post(endpoint)
        .set(self.headers())
        .type('json')
        .accept('json')
        .send(mapperV2[msg.action()](msg, self.settings))
        .end(function(err, res) {
          if (err && err.timeout) {
            return self.unlock(key, function() {
              fn(err, res);
            });
          }

          self.setLimit(res.headers, function() {
            if (err) {
              return self.unlock(key, function() {
                return fn(err, res);
              });
            }

            // Store jobId in redis
            // Set expiration to 14.75 mins since Intercom keeps
            // jobs open for 15 minutes, we want to add a buffer for more
            // reliability && higher success rate Note: We're not passing 'NX'
            // when storing in redis so we can overwrite over the same `jobKey`
            // since we just create a new job if we fail to an existing job
            // despite jobKey not expiring yet. So we need to be able to update
            // the `closing_at` for the same jobKey since it is now a new job
            var job = res.body;
            var expiration = Date.now() - job.closing_at - 15000;

            self.redis().set(
                jobKey, job.id, 'PX', expiration, function(fail, ok) {
                  // return original success response from Intercom Bulk API for
                  // better tests
                  self.unlock(key, function() {
                    return fn(err, res);
                  });
                });
          });
        });
  };

  self.limit(req, fn);
};

/**
 * Identify a user in intercom
 *
 * https://doc.intercom.io/api/#create-or-update-user
 *
 * @param {Identify} identify
 * @param {Function} fn
 * @api public
 */

Intercom.prototype.identifyV1 = function(identify, fn) {
  // custom metric
  STATS.incr('called', 1, ['method:identify', 'version:1']);
  var id = identify.userId() || identify.email();
  var key = [this.settings.appId, id].join(':');
  var self = this;
  var options = this.settings;

  this.lock(key, function(err) {
    if (err) {
      return fn(err)
    };

    var req = function() {
      self.post('/users')
          .set(self.headers())
          .type('json')
          .accept('json')
          .send(mapperV1.identify(identify, options))
          .end(function(err, res) {
            self.unlock(key, function() {
              if (err && err.timeout) {
                fn(err);
              }

              self.setLimit(res.headers, function() {
                fn(err, res);
              });
            });
          });
    };
    self.limit(req, fn);
  });
};

/**
 * Group in two steps - company and then user
 *
 * @param {Group} group
 * @param {Function} fn
 * @api public
 */

Intercom.prototype.groupV1 = function(group, fn) {
  STATS.incr('called', 1, ['method:group', 'version:1']);
  var json = group.json();
  var traits = json.traits || {};
  var self = this;
  var options = this.settings;

  var req = function() {
    self.post('/companies')
        .set(self.headers())
        .type('json')
        .accept('json')
        .send(mapperV1.group(group, options))
        .end(function(err, res) {
          if (err && err.timeout) {
            return fn();
          }

          self.setLimit(res.headers, function() {
            if (err) {
              return fn(err);
            }

            json.userId = group.userId();
            traits.id = group.groupId();
            json.traits = {companies: [traits]};
            var identify = new Identify(json);
            self.identify(identify, fn);
          });
        });
  };

  self.limit(req, fn);
};

/**
 * Track the user's action
 *
 * @param {Track} track
 * @param {Function} fn
 * @api public
 */

Intercom.prototype.trackV1 = function(track, fn) {
  STATS.incr('called', 1, ['method:track', 'version:1']);
  var options = this.settings;
  var self = this;

  var req = function() {
    self.post('/events')
        .set(self.headers())
        .type('json')
        .accept('json')
        .send(mapperV1.track(track, options))
        .end(function(err, res) {
          if (err && err.timeout) {
            return fn(err);
          }

          self.setLimit(res.headers, function() {
            return fn(err, res);
          });
        });
  };
  self.limit(req, fn);
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

Intercom.prototype.headers = function() {
  var auth;
  if (oauthTokenExists(this.settings.oauth)) {
    auth = 'Bearer ' + this.settings.oauth['access-token'];
  } else {
    var buf = new Buffer(this.settings.appId + ':' + this.settings.apiKey);
    auth = 'Basic ' + buf.toString('base64');
  }
  return {
    Authorization: auth,
    'User-Agent': this.userAgent
  };
}

/**
 *  Check Oauth Access Token Existance
 *
 *  @param {Object} oauthObject
 *  @return {Boolean}
 *  @api private
 */
function oauthTokenExists (oauthObject) {
  return oauthObject && oauthObject['access-token'] && oauthObject['access-token'].length;
};


/**
 * Set the partner request limit.
 *
 * @param {Function} headers
 * @param {Function} completion
 * @api private
 */

Intercom.prototype.setLimit = function(headers, completion) {
  var appId = this.settings.appId;
  var key = ['intercom', appId].join(':');
  var redis = this.redis();

  var limit = {
    remaining: headers['x-ratelimit-remaining'],
    reset: headers['x-ratelimit-reset']
  };

  // Expiration time in seconds (1 hour).
  var expire = 60 * 60;

  redis.set(key, JSON.stringify(limit), 'EX', expire, function(err, res) {
    completion();
  });
};

/**
 * Limits the integration to send too many request to the partner.
 *
 * @param {Function} fn
 * @param {Function} req
 * @api private
 */

Intercom.prototype.limit = function(req, fn) {
  var appId = this.settings.appId;
  var key = ['Intercom', appId].join(':');
  var redis = this.redis();

  redis.get(key, function(err, res) {
    if (!res || err) {
      return req();
    }

    var limit = JSON.parse(res);
    if (limit.remaining > 0) {
      return req();
    }

    var now = Date.now();
    if (now >= limit.reset) {
      return req();
    }

    err = new Error('too many requests')
    err.status = 429;
    fn(err);
  });
};