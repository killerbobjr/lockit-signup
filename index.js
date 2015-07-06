var path = require('path');
var events = require('events');
var util = require('util');
var express = require('express');
var uuid = require('shortid');	// Shortid instead of uuid
var ms = require('ms');
var moment = require('moment');
var Mail = require('lockit-sendmail');
var async = require('async');
var phone = require('phone');

/**
 * Internal helper functions
 */
function join(view)
{
	return path.join(__dirname, 'views', view);
}

function base64_to_base10(str)
{
	var order = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";
	var base = order.length;
	var num = 0, r;
	while (str.length)
	{
		r = order.indexOf(str.charAt(0));
		str = str.substr(1);
		num *= base;
		num += r;
	}
	return num;
}
	
function base10_to_base64(num)
{
	var order = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";
	var base = order.length;
	var str = "", r;
	while (num)
	{
		r = num % base;
		num -= r;
		num /= base;
		str = order.charAt(r) + str;
	}
	return str;
}

/**
 * Signup constructor function.
 *
 * @constructor
 * @param {Object} config
 * @param {Object} adapter
 */
var Signup = module.exports = function (config, adapter)
{
	if(!(this instanceof Signup))
		return new Signup(config, adapter);
	events.EventEmitter.call(this);

	this.config = config;
	this.adapter = adapter;

	var route = config.signup.route || '/signup';
	if(config.rest)
		route = '/rest' + route;

	var router = express.Router();
	router.get(route, this.getSignup.bind(this));
	router.post(route, this.postSignup.bind(this));
	router.get(route + '/resend-verification', this.getSignupResend.bind(this));
	router.post(route + '/resend-verification', this.postSignupResend.bind(this));
	router.get(route + '/:token', this.getSignupToken.bind(this));
	this.router = router;
};

util.inherits(Signup, events.EventEmitter);

/**
 * GET /signup.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
Signup.prototype.getSignup = function (req, res, next)
{
	// do not handle the route when REST is active
	if(this.config.rest)
		return next();

	// custom or built-in view
	var view = this.config.signup.views.signup || join('get-signup');

	res.render(view,
		{
			title: 'Sign up',
			basedir: req.app.get('views')
		});
};

/**
 * POST /signup.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
Signup.prototype.postSignup = function (req, res, next)
{
	var config = this.config;
	var adapter = this.adapter;
	var that = this;

	var name = req.body.name;
	var email = req.body.email;
	var password = req.body.password;
	var sms = req.body.phone;

	var error = null;
	// regexp from https://github.com/angular/angular.js/blob/master/src/ng/directive/input.js#L4
	var EMAIL_REGEXP = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}$/;
	var NAME_REGEXP = /^[\x20a-z0-9_-]{3,50}$/;

	// check for valid inputs
	if(!name || !email || !password)
	{
		error = 'All fields are required!';
	}
	else if(!name.match(NAME_REGEXP))
	{
		error = 'Must be between 3 to 50 characters containing only A-Z, a-z, 0-9, - _ or space';
		//  } else if (name !== name.toLowerCase()) {
		//    error = 'Username must be lowercase';
		//  } else if (!name.charAt(0).match(/[a-z]/)) {
		//    error = 'Username has to start with a lowercase letter (a-z)';
	}
	else if(!email.match(EMAIL_REGEXP))
	{
		error = 'You have entered an invalid email address';
	}
	else if(sms.length > 1 && phone(sms)[0] === undefined)
	{
		error = 'You have entered an invalid phone number';
	}
	else if(sms.length > 1)
	{
		sms = phone(sms)[0].replace(/\D/g,'');	// Strip the '+' character node-phone leaves in
	}

	// custom or built-in view
	var errorView = config.signup.views.signup || join('get-signup');

	if(error)
	{
		// send only JSON when REST is active
		if(config.rest)
			return res.json(403, { error: error });

		// render template with error message
		res.status(403);
		res.render(errorView,
			{
				title: 'Sign up',
				error: error,
				basedir: req.app.get('views'),
				name: name,
				email: email,
				phone: sms
			});
		return;
	}

	var checks = [];
	checks.push(
		{
			value: 'name',
			data: name
		});
	checks.push(
		{
			value: 'email',
			data: email
		});

	async.each(checks, function (check, nextasync)
		{
			adapter.find(check.value, check.data, function (err, user)
			{
				if(err)
					return next(err)
				else if(user !== undefined && user !== null)
				{
					if(user.accountInvalid)
						error = 'That account ' + check.value + ' cannot be used';
					else
						error = 'That account ' + check.value + ' already exists';
					nextasync();
				}
				else
					nextasync();
			});
		},
		function (err)
		{
			if(err)
				return next(err);
			else if(typeof error === 'string')
			{
				if(config.rest)
					return res.json(403, { error: error });
				else
				{
					// render template with error message
					res.status(403);
					res.render(errorView,
						{
							title: 'Sign up',
							error: error,
							basedir: req.app.get('views'),
							name: name,
							email: email,
							phone: sms
						});
					return;
				}
			}
			else
			{
				// save new user to db
				adapter.save(name, email, password, function (err, u)
					{
						if(err)
							return next(err);
						else
						{
							// send email with link for address verification
							//console.log('config: ', config);

							// This is a lazy hack that avoids modifying lockit-sendmail
							// so we can utilize sms email gateways. A better way is to
							// create a dedicated lockit-sms module and route the
							// authorize code through there if a phone number is provided.
							// That way, third party sms modules can be easily integrated.
							
							var	cfg = JSON.parse(JSON.stringify(config)),
								user = JSON.parse(JSON.stringify(u));
								
							if(sms.length > 1)
							{
								cfg.emailTemplate = cfg.smsTemplate;
								cfg.emailSignup = cfg.smsSignup;
								user.email = cfg.smsGateway;
								user.name = sms;			// Phone number
								cfg.appname = user.signupToken;	// Crowbar authorize code into here
							}
							var mail = new Mail(cfg);
							
							mail.signup(user.name, user.email, user.signupToken, function (err, result)
								{
									if(err)
										return next(err);
									else
									{
										// emit event
										that.emit('signup::post', user);

										// send only JSON when REST is active
										if(config.rest)
											return res.send(204);
										else if(sms.length > 1)
										{
											var successView = config.signup.views.smsSent || join('post-signup');
											res.render(successView,
												{
													title: 'Sign up - SMS code sent',
													basedir: req.app.get('views')
												});
										}
										else
										{
											var successView = config.signup.views.signedUp || join('post-signup');
											res.render(successView,
												{
													title: 'Sign up - Email sent',
													basedir: req.app.get('views')
												});
										}
									}
								});
						}
					});

			}
		});
};

/**
 * GET /signup/resend-verification.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
Signup.prototype.getSignupResend = function (req, res, next)
{
	// do not handle the route when REST is active
	if(this.config.rest)
		return next();

	// custom or built-in view
	var view = this.config.signup.views.resend || join('resend-verification');

	res.render(view,
		{
			title: 'Resend verification email',
			basedir: req.app.get('views')
		});
};

/**
 * POST /signup/resend-verification.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
Signup.prototype.postSignupResend = function (req, res, next)
{
	var config = this.config;
	var adapter = this.adapter;

	var email = req.body.email;
	var sms = req.body.phone;

	var error = null;
	// regexp from https://github.com/angular/angular.js/blob/master/src/ng/directive/input.js#L4
	var EMAIL_REGEXP = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}$/;

	if(!email || !email.match(EMAIL_REGEXP))
	{
		error = 'Email is invalid';
	}
	else if(sms.length > 1 && phone(sms)[0] === undefined)
	{
		error = 'You have entered an invalid phone number';
	}
	else if(sms.length > 1)
	{
		sms = phone(sms)[0].replace(/\D/g,'');	// Strip the '+' character node-phone leaves in
	}

	if(error)
	{
		// send only JSON when REST is active
		if(config.rest)
			return res.json(403, { error: error });

		// custom or built-in view
		var errorView = config.signup.views.resend || join('resend-verification');

		// render template with error message
		res.status(403);
		res.render(errorView,
			{
				title: 'Resend verification email',
				error: error,
				basedir: req.app.get('views')
			});
		return;
	}

	// check for user with given email address
	adapter.find('email', email, function (err, user)
	{
		if(err)
			return next(err);
		if(user)
		{
			if(user.accountInvalid)
			{
				error = 'That account email is invalid';
				// send only JSON when REST is active
				if(config.rest)
					return res.json(403, { error: error });

				var errorView = config.signup.views.resend || join('resend-verification');

				// render template with error message
				res.status(403);
				res.render(errorView,
					{
						title: 'Resend verification email',
						error: error,
						basedir: req.app.get('views'),
						email: email
					});
				return;
			}
			else
			{
				// send only JSON when REST is active
				if(config.rest)
					return res.send(204);

				// custom or built-in view
				var view = config.signup.views.verified || join('mail-verification-success');

				// render email verification success view
				return res.render(view,
					{
						title: 'Sign up success',
						basedir: req.app.get('views')
					});
			}
		}
		else
		{
			// send only JSON when REST is active
			if(config.rest)
				return res.send(204);

			var route = config.signup.route || '/signup';

			// render signup view
			return res.redirect(route);
		}	

		// custom or built-in view
		var successView = config.signup.views.signedUp || join('post-signup');

		// no user with that email address exists -> just render success message
		// or email address is already verified -> user has to use password reset function
		if(!user || user.emailVerified)
		{
			// send only JSON when REST is active
			if(config.rest)
				return res.send(204);

			return res.render(successView,
				{
					title: 'Sign up - Email sent',
					error: error,
					basedir: req.app.get('views')
				});
		}

		// we have an existing user with provided email address

		// create new signup token
		var token = base64_to_base10(uuid.generate()).toString();

		// save token on user object
		user.signupToken = token;

		// set new sign up token expiration date
		var timespan = ms(config.signup.tokenExpiration);
		user.signupTokenExpires = moment().add(timespan, 'ms').toDate();

		// save updated user to db
		adapter.update(user, function (err, user)
			{
				if(err) return next(err);

				// send sign up email
				var	cfg = JSON.parse(JSON.stringify(config)),
					user = JSON.parse(JSON.stringify(u));
					
				if(sms.length > 1)
				{
					cfg.emailTemplate = cfg.smsTemplate;
					cfg.emailSignup = cfg.smsSignup;
					user.email = cfg.smsGateway;
					user.name = sms;
					cfg.appname = user.signupToken;
				}
				
				var mail = new Mail(cfg);
				
				mail.signup(user.name, user.email, user.signupToken, function (err, result)
					{
						if(err)
							return next(err);
						else
						{
							// emit event
							that.emit('signup::post', user);

							// send only JSON when REST is active
							if(config.rest)
								return res.send(204);
							else if(sms.length > 1)
							{
								var successView = config.signup.views.smsSent || join('post-signup');
								res.render(successView,
									{
										title: 'Sign up - SMS code sent',
										basedir: req.app.get('views')
									});
							}
							else
							{
								var successView = config.signup.views.signedUp || join('post-signup');
								res.render(successView,
									{
										title: 'Sign up - Email sent',
										basedir: req.app.get('views')
									});
							}
						}
					});
			});

	});
};

/**
 * GET /signup/:token.
 *
 * Route is at the end so it does not
 * catch :token === 'resend-verification'.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
Signup.prototype.getSignupToken = function (req, res, next)
{
	var config = this.config;
	var adapter = this.adapter;
	var that = this;

	var token = req.params.token;

	// if format is wrong no need to query the database
	if(!uuid.isValid(base10_to_base64(token)))
		return next();

	// find user by token
	adapter.find('signupToken', token, function (err, user)
		{
			if(err)
				return next(err);

			// no user found -> forward to error handling middleware
			if(!user)
//				return next();
			{
				// custom or built-in view
				var expiredView = config.signup.views.linkExpired || join('link-expired');

				// render template to allow resending verification email
				return res.render(expiredView,
					{
						title: 'Sign up - Authorization invalid',
						error: 'Authorization code was not valid or has expired',
						basedir: req.app.get('views')
					});
			}

			// check if token has expired
			else if(new Date(user.signupTokenExpires) < new Date())
			{
				// delete old token
				delete user.signupToken;

				// save updated user to db
				adapter.update(user, function (err, user)
					{
						if(err)
							return next(err);

						// send only JSON when REST is active
						if(config.rest)
							return res.json(403, { error: 'token expired' });

						// custom or built-in view
						var expiredView = config.signup.views.linkExpired || join('link-expired');

						// render template to allow resending verification email
						res.render(expiredView,
							{
								title: 'Sign up - Authorization code has expired',
								basedir: req.app.get('views')
							});

					});
				return;
			}

			// everything seems to be fine

			// set user verification values
			user.emailVerificationTimestamp = new Date();
			user.emailVerified = true;

			// remove token and token expiration date from user object
			delete user.signupToken;
			delete user.signupTokenExpires;

			// save user with updated values to db
			adapter.update(user, function (err, user)
				{
					if(err)
						return next(err);

					// emit 'signup' event
					that.emit('signup', user, res);

					if(config.signup.handleResponse)
					{
						// send only JSON when REST is active
						if(config.rest)
							return res.send(204);

						// custom or built-in view
						var view = config.signup.views.verified || join('mail-verification-success');

						// render email verification success view
						res.render(view,
							{
								title: 'Sign up success',
								basedir: req.app.get('views')
							});
					}
				});
		});
};
