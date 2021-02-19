var	path = require('path'),
	events = require('events'),
	util = require('util'),
	express = require('express'),
	uuid = require('shortid'),	// Shortid instead of uuid
	ms = require('ms'),
	moment = require('moment'),
	Mail = require('lockit-sendmail'),
	async = require('async'),
	phone = require('phone'),
	debug = require('debug')('lockit');

/**
 * Internal helper functions
 */
function join(view)
{
	return path.join(__dirname, 'views', view);
}

/**
 * Signup constructor function.
 *
 * @constructor
 * @param {Object} config
 * @param {Object} adapter
 */
var Signup = module.exports = function (cfg, adapter)
{
	var that = this;
	
	if(!(this instanceof Signup))
	{
		return new Signup(config, adapter);
	}
	events.EventEmitter.call(this);

	this.config = cfg;
	this.adapter = adapter;
	
	var	config = this.config;

	// set default routes
	this.route = config.signup.route || '/signup';
	this.resendRoute = config.signup.resendRoute || '/resend';

	// change URLs if REST is active
	if (config.rest)
	{
		this.route = '/' + config.rest.route + this.route;
		this.resendRoute = '/' + config.rest.route + this.resendRoute;
	}

	var router = express.Router();
	router.get(this.route, this.getSignup.bind(this));
	router.post(this.route, this.postSignup.bind(this));
	router.get(this.resendRoute, this.getSignupResend.bind(this));
	router.post(this.resendRoute, this.postSignupResend.bind(this));
	router.get(this.route + '/:token', this.getSignupToken.bind(this));
	this.router = router;

};

util.inherits(Signup, events.EventEmitter);



/**
 * Response handler
 *
 * @param {Object} err
 * @param {String} view
 * @param {Object} user
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
Signup.prototype.sendResponse = function(err, view, user, json, redirect, req, res, next)
{
	var	config = this.config;

	this.emit((config.signup.eventMessage || 'Signup'), err, view, user, res);
	
	if(config.signup.handleResponse)
	{
		// do not handle the route when REST is active
		if(config.rest)
		{
			if(err)
			{
				res.status(403).json(err);
			}
			else
			{
				res.json(json);
			}
		}
		else
		{
			// custom or built-in view
			var	resp = {
					title: config.signup.title || 'Signup',
					basedir: req.app.get('views')
				};
				
			if(err)
			{
				resp.error = err.message;
			}
			else if(req.query && req.query.error)
			{
				resp.error = decodeURIComponent(req.query.error);
			}
			
			if(view)
			{
				var	file = path.resolve(path.normalize(resp.basedir + '/' + view));
				res.render(view, Object.assign(resp, json));
			}
			else if(redirect)
			{
				res.redirect(redirect);
			}
			else
			{
				res.status(404).send('<p>No file has been set for this view path in the Lockit.signup configuration.</p><p>Please make sure you set a valid file path for "login.views.signup".</p>');
			}
		}
	}
	else
	{
		next(err);
	}
};


/**
 * GET /signup.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
Signup.prototype.getSignup = function (req, res, next)
{
	var	config = this.config,
		// save redirect url
		suffix = req.query.redirect ? '?redirect=' + encodeURIComponent(req.query.redirect) : '';
	
	this.sendResponse(undefined, config.signup.views.signup, undefined, {action:this.route + suffix, result:true}, undefined, req, res, next);
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
	var	config = this.config,
		adapter = this.adapter,
		that = this,
		name = req.body.name,
		email = req.body.email,
		password = req.body.password,
		error,
		forgot = false,
		useLogin = false,
		NAME_REGEXP = /^[\x20A-Za-z0-9._%+-@]{3,50}$/,
		checkEmail = function(e)
		{
			var emailRegex = /^(([^<>()[\]\.,;:\s@\"]+(\.[^<>()[\]\.,;:\s@\"]+)*)|(\".+\"))@(([^<>()[\]\.,;:\s@\"]+\.)+[^<>()[\]\.,;:\s@\"]{2,})$/i;
			if(emailRegex.exec(e) && emailRegex.exec(e)[0] === e)
			{
				return true;
			}
			return false;
		};

	// Custom for our app
	var	basequery = {};
	if(res.locals && res.locals.basequery)
	{
		basequery = res.locals.basequery;
	}


	// check for valid inputs
	if(!password)
	{
		error = 'A password is required!';
	}
	else if(!name && !email)
	{
		error = 'A user name or email is required!';
	}
	else if(name && !email)
	{
		if(!name.match(NAME_REGEXP))
		{
			error = 'You have entered an invalid name!';
		}
		else
		{
			error = null;
		}
	}
	else if(!email.match(EMAIL_REGEXP))
	{
		error = 'You have entered an invalid email address!';
	}
	
	if(error)
	{
		this.sendResponse({message:error}, config.signup.views.signup, undefined, {result:true}, undefined, req, res, next);
	}
	else
	{
		var checks = [];
		if(email)
		{
			checks.push(
				{
					value: 'email',
					data: email
				});
		}
		if(name)
		{
			checks.push(
				{
					value: 'name',
					data: name
				});
		}
		async.each(checks, function (check, nextasync)
			{
				adapter.find(check.value, check.data, function (err, user)
				{
					if(err)
					{
						return nextasync(err);
					}
					else if(user !== undefined && user !== null)
					{
						if(user.accountInvalid)
						{
							error = 'The ' + check.value + ' "' + user.email + '" has been deactivated';
						}
						else
						{
							if(check.value === 'email')
							{
								error = 'The email account "' + user.email + '" is already signed up.';
							}
							else
							{
								error = 'The user "' + user.name + '" is already signed up.';
							}
							useLogin = config.signup.useLogin;
							forgot = true;
						}
						return nextasync();
					}
					else
					{
						nextasync();
					}
				}, basequery);
			},
			function (err)
			{
				if(err)
				{
					next(err);
				}
				else if(typeof error === 'string')
				{
					if(useLogin)
					{
						config.signup.rerouted = true;
						res.redirect(307, config.login.route);
					}
					else
					{
						that.sendResponse({message:error}, config.signup.views.signup, undefined, {result:true}, undefined, req, res, next);
					}
				}
				else
				{
					// save new user to db
					adapter.save(name, email, password, function (err, user)
						{
							if(err)
							{
								next(err);
							}
							else
							{
								if(config.signup.completionRoute)
								{
									if(typeof config.signup.completionRoute === 'function')
									{
										config.signup.completionRoute(user, req, res, function(err, req, res)
											{
												if(err)
												{
													next(err);
												}
												else
												{
													that.sendResponse(undefined, req.query.redirect?undefined:config.signup.views.signedup, user, {result:true}, req.query.redirect, req, res, next);
												}
											});
									}
									else
									{
										that.sendResponse(undefined, undefined, user, {result:true}, config.signup.completionRoute, req, res, next);
									}
								}
								else
								{
									that.sendResponse(undefined, config.signup.views.signedup, user, {result:true}, undefined, req, res, next);
								}
							}
						});
				}
			});
	}
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
	var	config = this.config,
		// save redirect url
		suffix = req.query.redirect ? '?redirect=' + encodeURIComponent(req.query.redirect) : '';
	
	this.sendResponse(undefined, config.signup.views.resend, undefined, {action:this.resendRoute + suffix, result:true}, undefined, req, res, next);
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
	var	config = this.config,
		adapter = this.adapter,
		that = this,
		email = req.body.email,
		name = req.body.name,
		sms = req.body.phone,
		command = req.body.command,	// command to return after success
		error,
		token,
		timespan,
		// regexp from https://github.com/angular/angular.js/blob/master/src/ng/directive/input.js#L4
		EMAIL_REGEXP = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}$/;

	if(!email || !email.match(EMAIL_REGEXP))
	{
		error = 'Email is invalid';
	}
	else if(sms !== undefined)
	{
		if(sms.length > 1 && phone(sms)[0] === undefined)
		{
			error = 'You have entered an invalid phone number';
		}
		else if(sms.length > 1)
		{
			sms = phone(sms)[0].replace(/\D/g,'');	// Strip the '+' character node-phone leaves in
		}
	}

	if(error)
	{
		that.sendResponse({message:error}, config.signup.views.resend, undefined, {result:true}, undefined, req, res, next);
	}
	else
	{
		// Custom for our app
		var	basequery = {};
		if(res.locals && res.locals.basequery)
		{
			basequery = res.locals.basequery;
		}

		// check for user with given email address
		adapter.find(name !== undefined?'name':'email', name !== undefined?name:email, function (err, user)
			{
				if(err)
				{
					next(err);
				}
				else if(user === undefined || user === null)
				{
					// User email not found. Signup redirect.
					that.sendResponse(undefined, undefined, undefined, {result:true}, config.signup.route, req, res, next);
				}
				else if(user)
				{
					// Locked or deleted user account?
					if(user.accountInvalid || user.accountLocked)
					{
						that.sendResponse({message:'That email is invalid'}, config.signup.views.resend, undefined, {result:true}, undefined, req, res, next);
					}
					else
					{
						// Has email already been verified?
						if(user.emailVerified)
						{
							// Check if we're verifying the phone number
							if(sms !== undefined && sms.length > 1 && config.sms.client !== undefined)
							{
								// create new signup token
								token = uuid.generate();

								// save token on user object
								user.signupToken = token;

								// set new sign up token expiration date
								timespan = ms(config.signup.tokenExpiration);
								user.signupTokenExpires = moment().add(timespan, 'ms').toDate();
								
								if(process.env.NODE_ENV === 'production')
								{
									config.sms.client(sms, config.sms.message + ' ' + user.signupToken, 	function(err, message)
										{
											if (err)
											{
												// The code was not sent via SMS
												that.sendResponse(err, config.signup.views.verify, undefined, {result:true}, undefined, req, res, next);
											}
											else
											{
												user.phoneNumber = sms;
												user.phoneVerified = false;
												// save updated user to db
												adapter.update(user, function (err, user)
													{
														if(err)
														{
															next(err);
														}
														else
														{
															that.sendResponse(undefined, config.signup.views.smsSent, undefined, {result:true}, undefined, req, res, next);
														}
													});
											}
										});
								}
								else
								{
									debug('----------------------------------------');
									debug(config.sms.message + ' ' + user.signupToken);
									debug('----------------------------------------');
									user.phoneNumber = sms;
									user.phoneVerified = false;
									// save updated user to db
									adapter.update(user, function (err, user)
										{
											if(err)
											{
												next(err);
											}
											else
											{
												that.sendResponse(undefined, config.signup.views.smsSent, undefined, {result:true}, undefined, req, res, next);
											}
										});
								}
							}
							else
							{
								// Already verified.
								
								// Clear flag in case of a previous failed verification.
								// If previous start of verification was done by mistake,
								// user will have to verify phone all over again
								user.phoneVerified = undefined;
								
								adapter.update(user, function (err, user)
									{
										if(err)
										{
											next(err);
										}
										else
										{
											if(config.signup.completionResendRoute)
											{
												if(typeof config.signup.completionResendRoute === 'function')
												{
													config.signup.completionResendRoute(user, req, res, function(err, req, res)
														{
															if(err)
															{
																next(err);
															}
															else
															{
																that.sendResponse(undefined, req.query.redirect?undefined:config.signup.views.verified, user, {result:true}, req.query.redirect, req, res, next);
															}
														});
												}
												else
												{
													that.sendResponse(undefined, undefined, user, {result:true}, config.signup.completionResendRoute, req, res, next);
												}
											}
											else
											{
												that.sendResponse(undefined, config.signup.views.verified, user, {result:true}, undefined, req, res, next);
											}
										}
									});
							}
						}
						else
						{
							// First time verification

							// create new signup token
							token = uuid.generate();

							// save token on user object
							user.signupToken = token;

							// set new sign up token expiration date
							timespan = ms(config.signup.tokenExpiration);
							user.signupTokenExpires = moment().add(timespan, 'ms').toDate();
							
							// If we're doing an email verification, save that temporarily
							user.email = email;

							// save updated user to db
							adapter.update(user, function (err, user)
								{
									if(err)
									{
										next(err);
									}
									else
									{
										// Using phone number for verification?
										if(sms !== undefined && sms.length > 1 && config.sms.client !== undefined)
										{
											if(process.env.NODE_ENV === 'production')
											{
												config.sms.client(sms, config.sms.message + ' ' + user.signupToken, 	function(err, message)
													{
														if (err)
														{
															// The code was not sent via SMS
															that.sendResponse(err, config.signup.views.verify, undefined, {result:true}, undefined, req, res, next);
														}
														else
														{
															user.phoneNumber = sms;
															user.phoneVerified = false;
															// save updated user to db
															adapter.update(user, function (err, user)
																{
																	if(err)
																	{
																		next(err);
																	}
																	else
																	{
																		that.sendResponse(undefined, config.signup.views.smsSent, undefined, {result:true}, undefined, req, res, next);
																	}
																});
														}
													});
											}
											else
											{
												debug('----------------------------------------');
												debug(config.sms.message + ' ' + user.signupToken);
												debug('----------------------------------------');
												user.phoneNumber = sms;
												user.phoneVerified = false;
												// save updated user to db
												adapter.update(user, function (err, user)
													{
														if(err)
														{
															next(err);
														}
														else
														{
															that.sendResponse(undefined, config.signup.views.smsSent, undefined, {result:true}, undefined, req, res, next);
														}
													});
											}
										}
										else
										{
											// Using email for verification
											
											// send sign up email
											var	mail = new Mail(config);
											
											mail.signup(user.name, user.email, user.signupToken, function (err, result)
												{
													if(err)
													{
														that.sendResponse(err, config.signup.views.route, user, {result:true}, req, res, next);
													}
													else
													{
														that.sendResponse(undefined, config.signup.views.signedUp, undefined, {result:true}, undefined, req, res, next);
													}
												});
										}
									}
								});
						}
					}
				}
			}, basequery);
	}
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
	var	config = this.config,
		adapter = this.adapter,
		that = this,
		command = req.query.command,
		token = req.params.token,
		view;

	// Reset alphabet
	uuid.generate();
	
	if(token)
	{
		if(token.length > 0)
		{
			// if format is wrong no need to query the database
			if(!uuid.isValid(token))
			{
				that.sendResponse(undefined, config.signup.views.linkExpired, undefined, {result:true}, undefined, req, res, next);
			}
			else
			{

				// Custom for our app
				var	basequery = {};
				if(res.locals && res.locals.basequery)
				{
					basequery = res.locals.basequery;
				}

				// find user by token
				adapter.find('signupToken', token, function (err, user)
					{
						if(err)
						{
							next(err);
						}
						else
						{
							// no user found -> forward to error handling middleware
							if(!user)
							{
								that.sendResponse(undefined, config.signup.views.linkExpired, undefined, {result:true}, undefined, req, res, next);
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
										{
											next(err);
										}
										else
										{
											that.sendResponse(undefined, config.signup.views.linkExpired, undefined, {result:true}, undefined, req, res, next);
										}
									});
							}
							else
							{
								// everything seems to be fine

								// set user verification values
								user.emailVerificationTimestamp = new Date();
								user.emailVerified = true;
								
								// If the number was previously saved,
								if(user.phoneNumber !== undefined)
								{
									// And the flag exists
									if(user.phoneVerified !== undefined && user.phoneVerified !== null && user.phoneVerified === false)
									{
										// We validated via phone, so set flag;
										user.phoneVerified = true;
									}
								}

								// remove token and token expiration date from user object
								delete user.signupToken;
								delete user.signupTokenExpires;

								// save user with updated values to db
								adapter.update(user, function (err, user)
									{
										if(err)
										{
											next(err);
										}
										else
										{
											if(config.signup.completionResendRoute)
											{
												if(typeof config.signup.completionResendRoute === 'function')
												{
													config.signup.completionResendRoute(user, req, res, function(err, req, res)
														{
															if(err)
															{
																next(err);
															}
															else
															{
																that.sendResponse(undefined, req.query.redirect?undefined:config.signup.views.verified, user, {result:true}, req.query.redirect, req, res, next);
															}
														});
												}
												else
												{
													that.sendResponse(undefined, undefined, user, {result:true}, config.signup.completionResendRoute, req, res, next);
												}
											}
											else
											{
												that.sendResponse(undefined, config.signup.views.verified, user, {result:true}, undefined, req, res, next);
											}
										}
									});
							}
						}
					}, basequery);
			}
		}
		else
		{
			that.sendResponse(undefined, config.signup.views.linkExpired, undefined, {result:true}, undefined, req, res, next);
		}
	}
	else
	{
		that.sendResponse(undefined, config.signup.views.linkExpired, undefined, {result:true}, undefined, req, res, next);
	}
};
