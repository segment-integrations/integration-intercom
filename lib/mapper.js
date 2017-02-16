/**
 * Module dependencies.
 */

var isostring = require('isostring');
var hash = require('string-hash');
var time = require('unix-time');
var dot = require('obj-case');
var flatten = require('flat');
var is = require('is');
var foldl = require('@ndhoule/foldl');
var clone = require('lodash/clone');
var pick = require('lodash/pick');
var each = require('@ndhoule/each');
var remove = require('obj-case').del;
var extend = require('@ndhoule/extend');

/**
 * Map identify `msg`.
 *
 * @param {Identify} msg
 * @param {Object} settings
 * @return {Object}
 */

exports.identify = function(msg, settings) {
  var traits = formatTraits(msg.traits());
  var context = msg.options('Intercom');
  var active = msg.active();
  var email = msg.email();
  var ret = {};

  ret.user_id = msg.userId();
  ret.custom_attributes = traits;

  if (msg.created()) ret.remote_created_at = time(msg.created());
  if (active) ret.last_request_at = traits.lastRequestAt || time(msg.timestamp());
  if (traits.lastRequestAt) delete traits["lastRequestAt"];
  if (msg.ip()) ret.last_seen_ip = msg.ip();
  if (email) ret.email = email;
  if (msg.name()) ret.name = msg.name();
  if (msg.userAgent()) ret.last_seen_user_agent = msg.userAgent();

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

  // Add phone data
  if (msg.phone()) ret.phone = msg.phone();

  delete ret.custom_attributes.company;
  delete ret.custom_attributes.companies;
  delete ret.custom_attributes.phone;

  ret.custom_attributes = formatNested(ret.custom_attributes, settings);

  return ret;
};

/**
 * Map track `msg`.
 *
 * @param {Track} msg
 * @param {Object} settings
 * @return {Object}
 */

exports.track = function(msg, settings) {
  var ret = {};
  var revenue = msg.revenue();
  if (revenue) {
    var revenueData = {
      //Intercom requests value in cents
      price: {
        amount: revenue * 100,
        currency: msg.currency() // fallsback on 'USD'
      }
    };
  }

  ret.created = time(msg.timestamp());
  ret.event_name = msg.event();
  ret.user_id = msg.userId();
  if (msg.email()) ret.email = msg.email();
  ret.metadata = formatNested(formatMetadata(msg.properties()), settings);
  ret.metadata = extend(ret.metadata, revenueData);
  remove(ret.metadata, 'revenue');
  remove(ret.metadata, 'currency');
  return ret;
};

/**
 * Map group `msg`.
 *
 * @param {Group} msg
 * @param {Object} settings
 * @return {Object}
 */

exports.group = function(msg, settings) {
  var ret = {};
  ret.remote_created_at = time(msg.created());
  ret.company_id = msg.groupId();
  ret.name = msg.name();
  ret.monthly_spend = msg.proxy('traits.monthlySpend');
  ret.plan = msg.proxy('traits.plan');
  ret.custom_attributes = formatTraits(msg.traits());
  delete ret.custom_attributes.companies;
  delete ret.custom_attributes.company;
  ret.custom_attributes = formatNested(ret.custom_attributes, settings);
  return ret;
};

/**
 * Formats a company for use with intercom
 *
 * http://docs.intercom.io/#Companies
 *
 * TODO: add .companies()
 *
 * @param {Object} company
 * @return {Object}
 * @api private
 */

function formatCompany(company, settings) {
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

  formatNested(ret.custom_attributes, settings);

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

function formatTraits(traits) {
  if (is.array(traits)) return traits.map(formatTraits);
  if (!is.object(traits)) return traits;

  var ret = {};
  Object.keys(traits).forEach(function(key) {
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

function formatMetadata(props) {
  var ret = {};

  Object.keys(props).forEach(function(key) {
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

    if (is.object(val)) {
      return ret[key] = val;
    }
  });

  return ret;
}

/**
 + * Flatten selectively based on your settings. You can either stringify, flatten, or drop the properties.
 + * Intercom rejects nested objects so you must choose a method.
 + *
 + * @param {Object} obj
 + * @param {Object} settings
 + * @return {Object} ret
 + * @api private
 + */
 
 function formatNested(obj, settings){
   var blacklisted = settings.blacklisted || {};
   var defaultMethod = settings.defaultMethod || 'flatten';
   var richLinkProperties = settings.richLinkProperties || [];
 
   // have to remove rich link object from traits to be formatted and add it back in later
   // clone obj so we dont modify the original
   var traitsToFormat = clone(obj);
 
   // remove rich link object from nested traits to be modified
   each(function(property){
     remove(traitsToFormat, property)
   },richLinkProperties);
 
   // create obj with rich link object to add to traits in the end
   var richLinkTraits = pick(obj, richLinkProperties);
 
   var  formattedTraits = foldl(function(attrs, value, key){
     var trait = blacklisted[key];
 
     if (trait === 'stringify') {
       attrs.stringify[key] = value;
     } else if (trait === 'flatten') {
       attrs.flatten[key] = value;
     } else if (trait === 'drop') {
        return attrs;
    } else if (typeof value === 'object') {
      if (defaultMethod === 'stringify') attrs.stringify[key] = value;
      if (defaultMethod === 'flatten') attrs.flatten[key] = value;
      if (defaultMethod === 'drop') return attrs;
    } else {
      attrs.nonNestedTraits[key] = value;
    }
    return attrs; 
  }, { flatten: {}, stringify: {}, nonNestedTraits: {} }, traitsToFormat);
  
  // stringify specified traits
  var stringifiedTraits = foldl(function(ret, value, key) {
    ret[key] = JSON.stringify(value);
    return ret;
  }, {}, formattedTraits.stringify);

  // flatten specified traits
  var flattenedTraits = foldl(function(ret, value, key) {
    var pair = {};
    pair[key] = value;
    ret = extend(flatten(pair), ret);
    return ret;
  }, {}, formattedTraits.flatten);

  //combine all traits
return extend(stringifiedTraits, flattenedTraits, formattedTraits.nonNestedTraits, richLinkTraits);
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

function dateKey(key) {
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

function endswith(str, suffix) {
  return str.substr(str.length - suffix.length) === suffix;
}
