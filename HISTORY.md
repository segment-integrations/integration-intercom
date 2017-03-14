
2.6.1 / 2017-03-14
==================

  * Update logic + tests 

2.6.0 / 2017-03-13
==================

  * Merge both legacy 2016-10-26 versioned integration so that we can support both based on setting 

2.5.0 / 2017-03-08
==================

  * package: remove "integration-version"

2.4.0 / 2017-02-23
==================

  * Add option to use access-token to authenticate, falling back to api key

2.3.1 / 2017-02-16
==================

  * Add option to let customers decide how they would like their custom nested traits to be handled
  * Fix unsubscribe bug
  * Add special hanlding for Rich Link

2.2.1 / 2017-02-01
==================

  * Map context.userAgent to last_seen_user_agent

2.2.0 / 2017-01-31
==================

  * Standardize integration (linting, Docker configuration, circle.yml, upgrade
segmentio-integration version, upgrade integration-worker version, etc.)


2.1.2 / 2017-01-05
===================

  * Handle error in case of error from Intercom API

2.1.1 / 2016-12-20
===================

  * Move traits.phone into top level standard attr rather than custom_attributes

2.1.0 / 2016-11-14
===================

  * Remove redudant traits that were mapped semantically already for identify calls

2.0.0 / 2016-11-07
===================

  * Migrate `.track()` and `.group()` calls to use Intercom's Bulk API

1.0.17 / 2016-10-12
===================

  * flatten custom attrs and remove redundant company fields in custom attrs
  * Update segmentio-integration to v5 (#23)

1.0.16 / 2016-07-20
===================

  * add option to pass specific context info as custom attributes on Identify

1.0.15 / 2016-02-24
===================

  * add support for unsubscribing users from email

1.0.14 / 2016-01-30
===================

  * update to send revenue as cents per Intercom docs

1.0.13 / 2016-01-30
===================

  * Update revenue to be sent in cents per Intercom expectations

1.0.12 / 2015-10-28
===================

  * Map revenue and currency

1.0.11 / 2015-09-29
===================

  * Merge pull request #8 from segmentio/last-request-at
  * last_request_at is now populated with passed in value if available.

1.0.10 / 2015-09-25
===================

  * Support removal of company from user profile

1.0.9 / 2015-07-28
==================

  * Improve success rate of messages by sending them according to the spec
  * Update circle template

1.0.8 / 2014-12-08
==================

 * bump segmentio-integration

1.0.7 / 2014-12-04
==================

 * Remove retry on 429 for now

1.0.6 / 2014-12-03
==================

 * Add custom retry

1.0.5 / 2014-12-03
==================

  * remove nextTick

1.0.4 / 2014-12-02
==================

 * bump integration proto

1.0.3 / 2014-12-02
==================

 * remove .retries()
 * fix dev deps
 * bump dev deps

1.0.2 / 2014-12-02
==================

 * bump segmentio-integration

1.0.1 / 2014-11-21
==================

 * Bumping segmentio-integration
 * fix build status badge

1.0.0 / 2014-11-14
==================

  * Initial release
