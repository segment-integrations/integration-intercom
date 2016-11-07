/**
 * Module dependencies.
 */

var isostring = require('isostring');
var hash = require('string-hash');
var time = require('unix-time');
var dot = require('obj-case');
var flatten = require('flat');
var is = require('is');
var each = require('@ndhoule/each');
var remove = require('obj-case').del;
var reject = require('reject');
var extend = require('@ndhoule/extend');

/**
 * Map identify `msg`.
 *
 * @param {Identify} msg
 * @param {Object} settings
 * @return {Object}
 */

exports.identify = function(msg, settings){
  var traits = formatTraits(msg.traits());
  var context = msg.options(this.name);
  var active = msg.active();
  var email = msg.email();
  var ret = {};

  ret.user_id = msg.userId();
  ret.custom_attributes = traits;

  if (msg.created()) ret.remote_created_at = time(msg.created());
  if (active) ret.last_request_at = traits.lastRequestAt || time(msg.timestamp());
  if (traits.lastRequestAt) delete traits.lastRequestAt;
  if (msg.ip()) ret.last_seen_ip = msg.ip();
  if (email) ret.email = email;
  if (msg.name()) ret.name = msg.name();

  if (settings.collectContext) {
    var deviceType = msg.proxy('context.device.type');
    var deviceManufacturer = msg.proxy('context.device.manufacturer');
    var deviceModel = msg.proxy('context.device.model');
    var osName = msg.proxy('context.os.name');
    var osVersion = msg.proxy('context.os.version');
    var appName = msg.proxy('context.app.name');
    var appVersion = msg.proxy('context.app.version');
    if (deviceType) ret.custom_attributes.device_type = deviceType;
    if (deviceManufacturer) ret.custom_attributes.device_manufacturer = deviceManufacturer;
    if (deviceModel) ret.custom_attributes.device_model = deviceModel;
    if (osName) ret.custom_attributes.os_name = osName;
    if (osVersion) ret.custom_attributes.os_version = osVersion;
    if (appName) ret.custom_attributes.app_name = appName;
    if (appVersion) ret.custom_attributes.app_version = appVersion;
  }

  // Unsubscribe user with manual flag in context.Intercom
  // https://developers.intercom.io/docs/create-or-update-user
  // Comparing to `undefined` since they could send `false`
  if (context.unsubscribedFromEmails != undefined && is.boolean(context.unsubscribedFromEmails)) {
    ret.unsubscribed_from_emails = context.unsubscribedFromEmails;
  }

  // Add company data
  var companies = dot(traits, 'companies');
  var company = dot(traits, 'company');

  if (company) companies = [company];
  if (is.array(companies)) ret.companies = companies.map(formatCompany);

  delete ret.custom_attributes.company;
  delete ret.custom_attributes.companies;
  ret.custom_attributes = flatten(ret.custom_attributes);

  return ret;
};

/**
 * Map track `msg`.
 *
 * Intercom request we still use bulk API for events for scalability reasons
 * https://developers.intercom.com/reference#bulk-event-operations
 *
 * @param {Track} msg
 * @param {Object} settings
 * @return {Object}
 */

exports.track = function(track){
  var ret = { items: [] };
  var revenue = track.revenue();
  var properties = flatten(formatMetadata(track.properties()));
  if (revenue) {
    var revenueData = {
      //Intercom requests value in cents
      price: {
        amount: revenue * 100,
        currency: track.currency() // fallsback on 'USD'
      }
    };
    delete ret.revenue;
    delete ret.currency;
  }

  properties = extend(properties, revenueData);
  remove(properties, 'revenue');
  remove(properties, 'currency');

  var job = {
    method: 'post',
    data_type: 'event',
    data: {
      event_name: track.event(),
      created_at: time(track.timestamp()),
      user_id: track.userId(),
      metadata: properties
    }
  };

  if (track.email()) job.data.email = msg.email();

  ret.items.push(job);

  return ret;
};

/**
 * Map group `msg`.
 *
 * Intercom request we still use bulk API for even groups for scalability reasons
 * https://developers.intercom.com/reference#bulk-user-operations
 *
 * @param {Group} msg
 * @return {Object}
 */

exports.group = function(msg) {
  var ret = { items: [] };
  var customTraits = formatTraits(msg.traits());
  var semanticTraits = [
    'companies',
    'company',
    'createdAt',
    'created_at',
    'custom_attributes',
    'company_id',
    'id',
    'name',
    'monthlySpend',
    'monthly_spend',
    'plan',
    'remote_created_at'
  ];

  // Remove duplicate/semantic traits
  each(function(trait){
    remove(customTraits, trait);
  }, semanticTraits);

  // Reject any undefined/null values
  var companyData = reject({
    remote_created_at: time(msg.created()),
    company_id: msg.groupId(),
    name: msg.name(),
    monthly_spend: msg.proxy('traits.monthlySpend'),
    plan: msg.proxy('traits.plan'),
    custom_attributes: flatten(customTraits)
  });
  var job = {
    method: 'post',
    data_type: 'user',
    data: {
      user_id: msg.userId(),
      companies: [companyData]
    }
  };

  ret.items.push(job);

  return ret;
};

/**
 * Formats a company for use with intercom
 *
 * http://docs.intercom.io/#Companies
 *
 * @param {Object} company
 * @return {Object}
 * @api private
 */

function formatCompany(company){
  if (is.string(company)) company = { name: company };

  var ret = {};
  ret.name = company.name;

  if (company.id) {
    ret.company_id = company.id;
    delete company.id;
  } else if (company.name) {
    ret.company_id = hash(company.name);
  }

  delete company.name;

  if (company !== undefined) ret.custom_attributes = company;

  // https://doc.intercom.io/api/#companies-and-users
  if (company.remove) {
    ret.remove = company.remove;
  }

  var created = dot(company, 'created') || dot(company, 'created_at');
  if (created) ret.remote_created_at = created;
  return ret;
}

/**
 * Format all the traits which are dates for intercoms format.
 *
 * https://doc.intercom.io/api/#custom-attributes
 *
 * @param {Object} traits
 * @return {Object}
 * @api private
 */

function formatTraits(traits){
  if (is.array(traits)) return traits.map(formatTraits);
  if (!is.object(traits)) return traits;

  var ret = {};
  Object.keys(traits).forEach(function(key){
    var val = traits[key];
    if (is.array(val)) return ret[key] = val.map(formatTraits);
    if (is.object(val)) return ret[key] = formatTraits(val);
    if (isostring(val) || is.date(val)) return ret[dateKey(key)] = time(val);
    ret[key] = val;
  });

  return ret;
}

/**
 * Format all the properties.
 *
 * https://developers.intercom.io/docs/event-metadata-types
 *
 * @param {Object} props
 * @return {Object}
 * @api private
 */

function formatMetadata(props){
  var ret = {};

  Object.keys(props).forEach(function(key){
    var val = props[key];

    if (is.boolean(val)) {
      ret[key] = String(val);
      return;
    }

    if (is.number(val) || is.string(val)) {
      ret[key] = val;
      return;
    }
    if (isostring(val) || is.date(val)) {
      ret[dateKey(key)] = time(val);
      return;
    }
    if (is.array(val)) {
      // Will flatten later
      ret[key] = val;
    }
    if (is.object(val)) {
      // Will flatten later
      return ret[key] = val;
    }
  });

  return ret;
}

/**
 * Set up a key with the dates for intercom
 *
 * http://docs.intercom.io/#CustomDataDates
 *
 * @param {String} key
 * @return {String}
 * @api private
 */

function dateKey(key){
  if (endswith(key, '_at')) return key;
  if (endswith(key, ' at')) return key.substr(0, key.length - 3) + '_at';
  if (endswith(key, 'At')) return key;
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

function endswith(str, suffix){
  return str.substr(str.length - suffix.length) === suffix;
}
