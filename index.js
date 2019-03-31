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
var twilio = require("twilio");

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
var Signup = module.exports = function (config, adapter)
{
	var that = this;
	
	if(!(this instanceof Signup))
	{
		return new Signup(config, adapter);
	}
	events.EventEmitter.call(this);

	this.config = config;
	this.adapter = adapter;

	var route = config.signup.route || '/signup';
	if(config.rest)
	{
		route = '/rest' + route;
	}

	var router = express.Router();
	router.get(route, this.getSignup.bind(this));
	router.post(route, this.postSignup.bind(this));
	router.get(route + '/resend-verification', this.getSignupResend.bind(this));
	router.post(route + '/resend-verification', this.postSignupResend.bind(this));
	router.get(route + '/:token', this.getSignupToken.bind(this));
	this.router = router;

	if(config.twilioSid !== undefined)
	{
		this.twilioClient = twilio(config.twilioSid, config.twilioToken);
	}
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
	{
		next();
	}
	else
	{
		// custom or built-in view
		var view = this.config.signup.views.signup || join('get-signup');

		res.render(view,
			{
				title: 'Sign up',
				basedir: req.app.get('views')
			});
	}
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

	var name = req.body.email;
	var email = req.body.email;
	var password = req.body.password;

	var error = null;
	var forgot = false;

	// regexp from https://github.com/angular/angular.js/blob/master/src/ng/directive/input.js#L4
	var EMAIL_REGEXP = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}$/;
	var NAME_REGEXP = /^[\x20A-Za-z0-9._%+-@]{3,50}$/;

	// check for valid inputs
	if(!email || !password)
	{
		error = 'All fields are required!';
	}
	else if(!email.match(EMAIL_REGEXP))
	{
		error = 'You have entered an invalid email address';
	}
	
	// custom or built-in view
	var errorView = config.signup.views.signup || join('get-signup');

	if(error)
	{
		// send only JSON when REST is active
		if(config.rest)
		{
			res.json(403, { error: error });
		}
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
					email: email
				});
		}
	}
	else
	{
		var checks = [];
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
					{
						next(err);
					}
					else if(user !== undefined && user !== null)
					{
						if(user.accountInvalid)
						{
							error = 'That account ' + check.value + ' has been deactivated';
						}
						else
						{
							error = 'That account ' + check.value + ' already exists!';
							forgot = true;
						}
						nextasync();
					}
					else
					{
						nextasync();
					}
				});
			},
			function (err)
			{
				if(err)
				{
					next(err);
				}
				else if(typeof error === 'string')
				{
					if(config.rest)
					{
						res.json(403, { error: error });
					}
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
								login: email,
								forgot: forgot
							});
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
								that.emit('signedup', user, res, req);

								if(config.signup.handleResponse)
								{
									// send only JSON when REST is active
									if(config.rest)
									{
										res.send(204);
									}
									else
									{
										// custom or built-in view
										var view = config.signup.views.signedup || join('mail-verification-success');

										// render email verification success view
										res.render(view,
											{
												title: 'Sign up success',
												basedir: req.app.get('views')
											});
									}
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
	// do not handle the route when REST is active
	if(this.config.rest)
	{
		next();
	}
	else
	{
		// custom or built-in view
		var view = this.config.signup.views.resend || join('resend-verification');

		res.render(view,
			{
				title: 'Resend verification email',
				basedir: req.app.get('views')
			});
	}
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
		sms = req.body.phone,
		error = '',
		// regexp from https://github.com/angular/angular.js/blob/master/src/ng/directive/input.js#L4
		EMAIL_REGEXP = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}$/;

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

	if(error.length > 0)
	{
		// send only JSON when REST is active
		if(config.rest)
		{
			res.json(403, { error: error });
		}
		else
		{
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
		}
	}
	else
	{
		// check for user with given email address
		adapter.find('email', email, function (err, user)
			{
				if(err)
				{
					next(err);
				}
				else if(user === undefined || user === null)
				{
					// User email not found. Signup redirect.
					
					// send only JSON when REST is active
					if(config.rest)
					{
						res.send(204);
					}
					else
					{
						var route = config.signup.route || '/signup';

						// render signup view
						res.redirect(route);
					}
				}
				else if(user)
				{
					// Locked or deleted user account?
					if(user.accountInvalid || user.accountLocked)
					{
						error = 'That email is invalid';
						
						// send only JSON when REST is active
						if(config.rest)
						{
							res.json(403, {error: error});
						}
						else
						{
							var errorView = config.signup.views.resend || join('resend-verification');

							// render template with error message
							res.status(403);

							res.render(errorView,
								{
									title: 'Invalid account',
									error: error,
									basedir: req.app.get('views'),
									email: email
								});
						}
					}
					else
					{
						// Has email already been verified?
						if(user.emailVerified)
						{
							// Check if we're verifying the phone number
							if(sms.length > 1 && that.twilioClient !== undefined)
							{
								// create new signup token
								var token = uuid.generate();

								// save token on user object
								user.signupToken = token;

								// set new sign up token expiration date
								var timespan = ms(config.signup.tokenExpiration);
								user.signupTokenExpires = moment().add(timespan, 'ms').toDate();
								
								that.twilioClient.messages.create(
									{
										to: sms,
										from: config.twilioNumber,
										body: config.twilioMessage + ' ' + user.signupToken
									},
									function(err, message)
									{
										if (err)
										{
											// The code was not sent via SMS
											console.log('twilio error:', err, ', message:', message);
											
											// do not handle the route when REST is active
											if(that.config.rest)
											{
												next();
											}
											else
											{
												// custom or built-in view
												var view = that.config.signup.views.verify || join('resend-verification');

												res.render(view,
													{
														title: 'Resend verification',
														error: err.message,
														basedir: req.app.get('views')
													});
											}
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
														console.log('twilio success');
														
														// emit event
														that.emit('signup::post', user);

														// send only JSON when REST is active
														if(config.rest)
														{
															res.send(204);
														}
														else
														{
															var successView = config.signup.views.smsSent || join('post-signup');
															res.render(successView,
																{
																	title: 'SMS code sent',
																	basedir: req.app.get('views')
																});
														}
													}
												});
										}
									});
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
											// send only JSON when REST is active
											if(config.rest)
											{
												res.send(204);
											}
											else
											{
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
									});
							}
						}
						else
						{
							// First time verification

							// create new signup token
							var token = uuid.generate();

							// save token on user object
							user.signupToken = token;

							// set new sign up token expiration date
							var timespan = ms(config.signup.tokenExpiration);
							user.signupTokenExpires = moment().add(timespan, 'ms').toDate();

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
										if(sms.length > 1 && that.twilioClient !== undefined)
										{
											that.twilioClient.messages.create(
												{
													to: sms,
													from: config.twilioNumber,
													body: config.twilioMessage + ' ' + user.signupToken
												},
												function(err, message)
												{
													if (err)
													{
														// The code was not sent via SMS
														console.log('twilio error:', err, ', message:', message);
														
														// do not handle the route when REST is active
														if(that.config.rest)
														{
															next();
														}
														else
														{
															// custom or built-in view
															var view = that.config.signup.views.resend || join('resend-verification');

															res.render(view,
																{
																	title: 'Resend verification',
																	error: err.message,
																	basedir: req.app.get('views')
																});
														}
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
																	console.log('twilio success');
																	
																	// emit event
																	that.emit('signup::post', user);

																	// send only JSON when REST is active
																	if(config.rest)
																	{
																		res.send(204);
																	}
																	else
																	{
																		var successView = config.signup.views.smsSent || join('post-signup');
																		res.render(successView,
																			{
																				title: 'SMS code sent',
																				basedir: req.app.get('views')
																			});
																	}
																}
															});
													}
												});
										}
										else
										{
											// Using email for verification
											
											// send sign up email
											var	cfg = JSON.parse(JSON.stringify(config)),
												use = JSON.parse(JSON.stringify(user)),
												mail = new Mail(cfg);
											
											mail.signup(use.name, use.email, use.signupToken, function (err, result)
												{
													if(err)
													{
														next(err);
													}
													else
													{
														// emit event
														that.emit('signup::post', use);

														// send only JSON when REST is active
														if(config.rest)
														{
															res.send(204);
														}
														else
														{
															var successView = config.signup.views.signedUp || join('post-signup');
															res.render(successView,
																{
																	title: 'Email sent',
																	basedir: req.app.get('views')
																});
														}
													}
												});
										}
									}
								});
						}
					}
				}
			});
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
		token = req.params.token;

	// Reset alphabet
	uuid.generate();
	
	if(token)
	{
		if(token.length > 0)
		{
			// if format is wrong no need to query the database
			if(!uuid.isValid(token))
			{
				// custom or built-in view
				var expiredView = config.signup.views.linkExpired || join('link-expired');

				// render template to allow resending verification email
				res.render(expiredView,
					{
						title: 'Authorization invalid',
						error: 'Authorization code was not valid or has expired',
						basedir: req.app.get('views')
					});
			}
			else
			{
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
								// custom or built-in view
								var expiredView = config.signup.views.linkExpired || join('link-expired');

								// render template to allow resending verification email
								res.render(expiredView,
									{
										title: 'Authorization invalid',
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
										{
											next(err);
										}
										else
										{
											// send only JSON when REST is active
											if(config.rest)
											{
												res.json(403, { error: 'token expired' });
											}
											else
											{
												// custom or built-in view
												var expiredView = config.signup.views.linkExpired || join('link-expired');

												// render template to allow resending verification email
												res.render(expiredView,
													{
														title: 'Authorization code has expired',
														basedir: req.app.get('views')
													});
											}
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
											// emit 'signup' event
											//console.log('emit signup event:', req);
											
											that.emit('verified', user, res, req);

											if(config.signup.handleResponse)
											{
												// send only JSON when REST is active
												if(config.rest)
												{
													res.send(204);
												}
												else
												{
													// custom or built-in view
													var view = config.signup.views.verified || join('mail-verification-success');

													// render email verification success view
													res.render(view,
														{
															title: 'Verification success',
															basedir: req.app.get('views')
														});
												}
											}
										}
									});
							}
						}
					});
			}
		}
		else
		{
			var view = that.config.signup.views.resend || join('resend-verification');
			// render template to allow resending verification email
			res.render(view,
				{
					title: 'Authorization invalid',
					error: 'Authorization code was not valid or has expired',
					basedir: req.app.get('views')
				});
		}
	}
	else
	{
		var view = that.config.signup.views.resend || join('resend-verification');
		// render template to allow resending verification email
		res.render(view,
			{
				title: 'Authorization invalid',
				error: 'Authorization code was not valid or has expired',
				basedir: req.app.get('views')
			});
	}
};
