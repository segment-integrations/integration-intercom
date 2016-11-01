
var Test = require('segmentio-integration-tester');
var helpers = require('./helpers');
var facade = require('segmentio-facade');
var hash = require('string-hash');
var mapper = require('../lib/mapper');
var time = require('unix-time');
var should = require('should');
var assert = require('assert');
var Intercom = require('..');
var redis = require('redis');
var uid = require('uid');

describe('Intercom', function(){
  var intercom;
  var settings;
  var payload;
  var test;
  var db;

  before(function(done){
    db = redis.createClient();
    db.on('ready', done);
    db.on('error', done);
  });

  beforeEach(function(){
    payload = {};
    settings = {
      appId: 'fcxywseo',
      apiKey: '9d068fa090d38be4c715b669b3f1370f76ac5306',
      collectContext: false
    };
    intercom = new Intercom(settings);
    test = Test(intercom, __dirname);
    test.mapper(mapper);
    intercom.redis(db);
  });

  it('should have correct settings', function(){
    test
      .name('Intercom')
      .endpoint('https://api-segment.intercom.io')
      .ensure('settings.apiKey')
      .ensure('settings.appId')
      .channels(['server']);
  });

  describe('.validate()', function(){

    it('should be invalid if .appId is missing', function(){
      delete settings.appId;
      test.invalid({}, settings);
    });

    it('should be invalid if .apiKey is missing', function(){
      delete settings.apiKey;
      test.invalid({}, settings);
    });

    it('should be invalid if .userId and .email are missing', function(){
      test.invalid({}, settings);
    });

    it('should be valid when just .userId is given', function(){
      test.valid({ userId: '12345' }, settings);
    });

    it('should be valid when just .email is given', function(){
      test.valid({ properties: { email: 'foo@bar.com' } }, settings);
    });

    it('should be valid when .apiKey and .appId are given', function(){
      test.valid({ userId: '12345' }, settings);
    });
  });

  describe('mapper', function(){
    describe('identify', function(){
      it('should map basic identify', function(){
        test.maps('identify-basic');
      });

      it('should map basic context', function(){
        test.maps('identify-context');
      });

      it('should map additional context if collectContext', function () {
        settings.collectContext = true;
        test.maps('identify-collect-context')
      });

      it('should respect .active()', function(){
        test.maps('identify-active');
      });

      it('should map nested dates', function(){
        test.maps('identify-nested-dates');
      });

      it('should map companies', function(){
        test.maps('identify-companies');
      });

      it('should map a company', function(){
        test.maps('identify-company');
      });

      it('should map companies with remove', function(){
        test.maps('identify-companies-remove');
      });

      it('should map a company with remove', function(){
        test.maps('identify-company-remove');
      });

      it('should update last_request_at with lastRequestAt when supplied', function(){
        test.maps('identify-last-request-at');
      });

      it('should update unsubscribed_from_emails with unsubscribedFromEmails when supplied', function(){
        test.maps('identify-unsubscribed-from-emails');
      });
    });

    describe('group', function(){
      it('should map basic group', function(){
        test.maps('group-basic');
      });
    });

    describe('track', function(){
      it('should map basic track', function(){
        test.maps('track-job-new');
      });
    });
  });

  describe('.identify()', function(){
    it('should be able to identify correctly', function(done){
      var msg = helpers.identify();

      var traits = intercom.formatTraits(msg.traits());
      delete traits.company;

      payload.user_id = msg.userId();
      payload.remote_created_at = time(msg.created());
      payload.last_request_at = time(msg.timestamp());
      payload.last_seen_ip = msg.ip();
      payload.email = msg.email();
      payload.name = msg.name();
      payload.custom_attributes = traits;
      payload.companies = [{
        company_id: hash('Segment.io'),
        custom_attributes: {},
        name: 'Segment.io'
      }];

      test
        .set(settings)
        .identify(msg)
        .sends(payload)
        .expects(200)
        .end(done);
    });

    it('should not error on invalid companies', function(done){
      var identify = helpers.identify({ traits: { companies: 'foo' }});
      intercom.identify(identify, function(err){
        should.not.exist(err);
        done();
      });
    });

    it('should send the ip address', function(done){
      var timestamp = new Date();
      test
        .set(settings)
        .identify({
          context: { ip: '70.211.71.236' },
          timestamp: timestamp,
          userId: 'userId'
        })
        .sends({
          custom_attributes: { id: 'userId' },
          last_request_at: time(timestamp),
          last_seen_ip: '70.211.71.236',
          user_id: 'userId',
        })
        .expects(200, done);
    });

    it('should error on invalid creds', function(done){
      test
        .set({ apiKey: 'x' })
        .identify({})
        .error('Unauthorized', done);
    });
  });

  describe('.group()', function(){
    // Create one persistent unique user to properly test locking logic
    // Also declare jobId for later tests
    var userId;
    var jobId;
    before(function(){
      userId = uid();
    });

    it('should create a new job for group', function(done){
      var json = test.fixture('group-job-new');
      json.input.userId = userId;
      json.output.items[0].data.user_id = userId;

      test
        .set(settings)
        .group(json.input)
        .sends(json.output)
        .expects(200)
        .end(function(err, res){
          if (err) return err;
          // save jobId for later tests
          jobId = res[0].res.body.id;
          done();
        });
    });

    it('should add to job if already exists', function(done){
      var json = test.fixture('group-job-existing');
      json.input.userId = userId;
      json.output.items[0].data.user_id = userId;
      json.output.job = { id: jobId };

      test
        .set(settings)
        .group(json.input)
        .sends(json.output)
        .expects(200)
        .end(done);
    });

    it('should work with .created_at', function(done){
      var json = test.fixture('group-job-created_at');
      json.input.userId = userId;
      json.output.items[0].data.user_id = userId;
      json.output.job = { id: jobId };

      test
        .set(settings)
        .group(json.input)
        .sends(json.output)
        .expects(200)
        .end(done);
    });

    it('should work with .createdAt', function(done){
      var json = test.fixture('group-job-createdAt');
      json.input.userId = userId;
      json.output.items[0].data.user_id = userId;
      json.output.job = { id: jobId };

      test
        .set(settings)
        .group(json.input)
        .sends(json.output)
        .expects(200)
        .end(done);
    });

    it('should just create a new job if adding to a job fails', function(done){
      var json = test.fixture('group-job-existing');
      json.input.userId = userId;
      json.output.items[0].data.user_id = userId;

      // Modify valid jobId stored in redis to be invalid
      var jobKey = [settings.appId, 'jobs', userId].join(':');
      intercom.redis().set(jobKey, 'garbage_id');

      var bulkRequests = test
        .requests(2)
        .set(settings)
        .group(json.input);

      // First Request
      bulkRequests
        .request(0)
        .expects(500); // TODO: is this expected? Why is this not 4xx?

      // Retry by creating new job
      bulkRequests
        .request(1)
        .sends(json.output)
        .expects(200)
        .end(done);
    });
  })

  describe('.track()', function(){
    // Create one persistent unique user to properly test locking logic
    // Also declare jobId for later tests
    var userId;
    var jobId;
    before(function(){
      userId = uid();
    });

    beforeEach(function(done){
      // Make a quick `.identify()` call with the userId so Intercom will
      // accept these `.track()` calls
      var userRequest = {
        type: 'identify',
        timestamp: '2016',
        userId: userId,
        traits: { created: '2016' }
      };
      test
        .request(0)
        .set(settings)
        .identify(userRequest)
        .expects(200)
        .end(done);
    });

    it('should create new job for track', function(done){
      var json = test.fixture('track-job-new');
      json.input.userId = userId;
      json.output.items[0].data.user_id = userId;

      test
        .request(1) // second req after beforeEach
        .set(settings)
        .track(json.input)
        .sends(json.output)
        .expects(200)
        .end(function(err, res) {
          if (err) return done(err);
          // save jobId for next test
          jobId = res[0].res.body.id;
          done();
        });
    });

    it('should add to job if already exists', function(done){
      var json = test.fixture('track-job-existing');
      json.input.userId = userId;
      json.output.items[0].data.user_id = userId;
      json.output.job = { id: jobId };

      test
        .request(1) // second req after beforeEach
        .set(settings)
        .track(json.input)
        .sends(json.output)
        .expects(200)
        .end(done);
    });

    it('should just create a new job if adding to a job fails', function(done){
      var json = test.fixture('track-job-existing');
      json.input.userId = userId;
      json.output.items[0].data.user_id = userId;

      // Modify valid jobId stored in redis to be invalid
      var jobKey = [settings.appId, 'jobs', userId].join(':');
      intercom.redis().set(jobKey, 'garbage_id');

      var bulkRequests = test
        .requests(3) // add the identify request from beforeEach
        .set(settings)
        .track(json.input);

      // First Request
      bulkRequests
        .request(1)
        .expects(500); // TODO: is this expected? Why is this not 4xx?

      // Retry by creating new job
      bulkRequests
        .request(2)
        .sends(json.output)
        .expects(200)
        .end(done);
    });

    it('should error on invalid creds', function(done){
      test
        .set({ apiKey: 'x' })
        .track({})
        .error('Unauthorized', done);
    });
  });
});
