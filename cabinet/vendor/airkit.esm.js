/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
/* global Reflect, Promise, SuppressedError, Symbol, Iterator */

var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
    return extendStatics(d, b);
};

function __extends(d, b) {
    if (typeof b !== "function" && b !== null)
        throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
    extendStatics(d, b);
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
}

function __values(o) {
    var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
    if (m) return m.call(o);
    if (o && typeof o.length === "number") return {
        next: function () {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
        }
    };
    throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}

function __read(o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
}

function __spreadArray(to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
}

function __classPrivateFieldGet(receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}

function __classPrivateFieldSet(receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
}

typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

var version = "1.11.1";
var airkitPackage = {
	version: version};

const AirAuthMessageTypes = {
    AUTH_SETUP_COMPLETED: "air_auth_setup_completed",
    INITIALIZATION_REQUEST: "air_auth_initialization_request",
    INITIALIZATION_RESPONSE: "air_auth_initialization_response",
    LOGIN_REQUEST: "air_auth_login_request",
    LOGIN_RESPONSE: "air_auth_login_response",
    LOGIN_SERVICE_STATUS_REQUEST: "air_auth_login_service_status_request",
    LOGIN_SERVICE_STATUS_RESPONSE: "air_auth_login_service_status_response",
    LOGIN_SERVICE_RESPONSE: "air_auth_login_service_response",
    UPDATE_SESSION_CONFIG_REQUEST: "air_auth_update_session_config_request",
    UPDATE_SESSION_CONFIG_RESPONSE: "air_auth_update_session_config_response",
    USER_INFO_REQUEST: "air_auth_user_info_request",
    USER_INFO_RESPONSE: "air_auth_user_info_response",
    PARTNER_USER_INFO_REQUEST: "air_auth_partner_user_info_request",
    PARTNER_USER_INFO_RESPONSE: "air_auth_partner_user_info_response",
    REFRESH_TOKEN_REQUEST: "air_auth_refresh_token_request",
    REFRESH_TOKEN_RESPONSE: "air_auth_refresh_token_response",
    WALLET_TOKEN_REQUEST: "air_auth_wallet_token_request",
    WALLET_TOKEN_RESPONSE: "air_auth_wallet_token_response",
    IFRAME_VISIBILITY_REQUEST: "air_auth_iframe_visibility_request",
    SETUP_WALLET_REQUEST: "air_auth_setup_wallet_request",
    SETUP_WALLET_RESPONSE: "air_auth_setup_wallet_response",
    SETUP_RECOVERY_REQUEST: "air_auth_setup_recovery_request",
    SETUP_RECOVERY_RESPONSE: "air_auth_setup_recovery_response",
    SETUP_CREDENTIAL_REQUEST: "air_auth_setup_credential_request",
    SETUP_CREDENTIAL_RESPONSE: "air_auth_setup_credential_response",
    SIGN_SIWE_MESSAGE_REQUEST: "air_auth_sign_siwe_message_request",
    SIGN_SIWE_MESSAGE_RESPONSE: "air_auth_sign_siwe_message_response",
    CROSS_PARTNER_TOKEN_REQUEST: "air_auth_cross_partner_token_request",
    CROSS_PARTNER_TOKEN_RESPONSE: "air_auth_cross_partner_token_response",
    PARTNER_ACCESS_TOKEN_REQUEST: "air_auth_partner_access_token_request",
    PARTNER_ACCESS_TOKEN_RESPONSE: "air_auth_partner_access_token_response",
    LOGOUT_REQUEST: "air_auth_logout_request",
    LOGOUT_RESPONSE: "air_auth_logout_response",
    START_RECOVERY_REQUEST: "air_start_recovery_request",
    START_RECOVERY_RESPONSE: "air_start_recovery_response",
    // Dashboard intent posted by recovery-frontend's RecoveryEntryView when
    // the user picks an action. Distinct from START_RECOVERY_REQUEST so that
    // when auth-frontend forwards the actual START_RECOVERY_REQUEST onto the
    // shared recovery channel, the local echo doesn't loop back into
    // auth-frontend's own recovery-channel subscription.
    START_RECOVERY_DASHBOARD_REQUEST: "air_start_recovery_dashboard_request",
    RECOVERY_REQUEST: "air_auth_recovery_request",
    RECOVERY_RESPONSE: "air_auth_recovery_response",
    // Mid-flow signing RPCs for the RECOVER_ACCOUNT flow. The recovery
    // private key never leaves recovery-frontend; auth-frontend asks for
    // a signature each time it needs one (after collecting the new email
    // for the canonical reset payload, and after the backend returns the
    // Privy authorization payload to wallet-PATCH).
    RECOVER_ACCOUNT_RESET_SIGNATURE_REQUEST: "air_auth_recover_account_reset_signature_request",
    RECOVER_ACCOUNT_RESET_SIGNATURE_RESPONSE: "air_auth_recover_account_reset_signature_response",
    RECOVER_ACCOUNT_AUTHORIZATION_SIGNATURE_REQUEST: "air_auth_recover_account_authorization_signature_request",
    RECOVER_ACCOUNT_AUTHORIZATION_SIGNATURE_RESPONSE: "air_auth_recover_account_authorization_signature_response",
    REMOVE_SIGNER_SIGNATURE_REQUEST: "air_auth_remove_signer_signature_request",
    REMOVE_SIGNER_SIGNATURE_RESPONSE: "air_auth_remove_signer_signature_response",
    RESET_WALLET_REQUEST: "air_auth_reset_wallet_request",
    RESET_WALLET_RESPONSE: "air_auth_reset_wallet_response",
    EXPIRED_LOGOUT_REQUEST: "air_auth_expired_logout_request",
};

const AirCredentialMessageTypes = {
    SERVICE_STARTED: "air_credential_service_started",
    INITIALIZATION_REQUEST: "air_credential_initialization_request",
    INITIALIZATION_RESPONSE: "air_credential_initialization_response",
    CREDENTIAL_IFRAME_VISIBILITY_REQUEST: "air_credential_iframe_visibility_request",
    UPDATE_SESSION_CONFIG_REQUEST: "air_credential_update_session_config_request",
    UPDATE_SESSION_CONFIG_RESPONSE: "air_credential_update_session_config_response",
    LOGOUT_REQUEST: "air_credential_logout_request",
    LOGOUT_RESPONSE: "air_credential_logout_response",
    CLOSE_MODAL_REQUEST: "air_credential_close_modal_request",
    CLOSE_MODAL_RESPONSE: "air_credential_close_modal_response",
    // New credential operation message types
    ISSUE_CREDENTIAL_REQUEST: "air_credential_issue_request",
    VERIFY_CREDENTIAL_REQUEST: "air_credential_verify_request",
    // Event messages for communication with parent
    ISSUE_CREDENTIAL_RESPONSE: "air_credential_issue_response",
    VERIFY_CREDENTIAL_RESPONSE: "air_credential_verify_response",
    ISSUE_ON_BEHALF_NEW_USER_CONFIRMATION_REQUEST: "air_credential_issue_on_behalf_new_user_confirmation_request",
    ISSUE_ON_BEHALF_NEW_USER_CONFIRMATION_RESPONSE: "air_credential_issue_on_behalf_new_user_confirmation_response",
};

const AirRecoveryMessageTypes = {
    SERVICE_STARTED: "air_recovery_service_started",
    INITIALIZATION_REQUEST: "air_recovery_initialization_request",
    INITIALIZATION_RESPONSE: "air_recovery_initialization_response",
    RECOVERY_INITIALIZED: "air_recovery_initialized",
    RECOVERY_IFRAME_VISIBILITY_REQUEST: "air_recovery_iframe_visibility_request",
    UPDATE_SESSION_CONFIG_REQUEST: "air_recovery_update_session_config_request",
    UPDATE_SESSION_CONFIG_RESPONSE: "air_recovery_update_session_config_response",
    GET_AGENT_KEYS_REQUEST: "air_recovery_get_agent_keys_request",
    GET_AGENT_KEYS_RESPONSE: "air_recovery_get_agent_keys_response",
    REGISTER_AGENT_KEY_REQUEST: "air_recovery_register_agent_key_request",
    REGISTER_AGENT_KEY_RESPONSE: "air_recovery_register_agent_key_response",
    REMOVE_AGENT_KEY_REQUEST: "air_recovery_remove_agent_key_request",
    REMOVE_AGENT_KEY_RESPONSE: "air_recovery_remove_agent_key_response",
    LOGOUT_REQUEST: "air_recovery_logout_request",
    LOGOUT_RESPONSE: "air_recovery_logout_response",
};

const AirWalletMessageTypes = {
    SERVICE_STARTED: "air_service_started",
    INITIALIZATION_REQUEST: "air_initialization_request",
    INITIALIZATION_RESPONSE: "air_initialization_response",
    CLOSE_MODAL_REQUEST: "air_wallet_close_modal_request",
    CLOSE_MODAL_RESPONSE: "air_wallet_close_modal_response",
    WALLET_INITIALIZED: "air_wallet_initialized",
    UPDATE_SESSION_CONFIG_REQUEST: "air_wallet_update_session_config_request",
    UPDATE_SESSION_CONFIG_RESPONSE: "air_wallet_update_session_config_response",
    WALLET_LOGIN_REQUEST: "air_wallet_login_request",
    WALLET_LOGIN_RESPONSE: "air_wallet_login_response",
    SETUP_OR_UPDATE_MFA_REQUEST: "air_setup_mfa_request",
    SETUP_OR_UPDATE_MFA_RESPONSE: "air_setup_mfa_response",
    CLAIM_ID_REQUEST: "air_claim_id_request",
    CLAIM_ID_RESPONSE: "air_claim_id_response",
    SHOW_SWAP_UI_REQUEST: "air_show_swap_ui_request",
    SHOW_SWAP_UI_RESPONSE: "air_show_swap_ui_response",
    SHOW_ON_RAMP_UI_REQUEST: "air_show_on_ramp_ui_request",
    SHOW_ON_RAMP_UI_RESPONSE: "air_show_on_ramp_ui_response",
    SHOW_TRANSFER_UI_REQUEST: "air_show_transfer_ui_request",
    SHOW_TRANSFER_UI_RESPONSE: "air_show_transfer_ui_response",
    SHOW_RECEIVE_UI_REQUEST: "air_show_receive_ui_request",
    SHOW_RECEIVE_UI_RESPONSE: "air_show_receive_ui_response",
    DEPLOY_SMART_ACCOUNT_REQUEST: "air_deploy_smart_account_request",
    DEPLOY_SMART_ACCOUNT_RESPONSE: "air_deploy_smart_account_response",
    WALLET_IFRAME_VISIBILITY_REQUEST: "air_wallet_iframe_visibility_request",
    IS_SMART_ACCOUNT_DEPLOYED_REQUEST: "air_is_smart_account_deployed_request",
    IS_SMART_ACCOUNT_DEPLOYED_RESPONSE: "air_is_smart_account_deployed_response",
    LOGOUT_REQUEST: "air_logout_request",
    LOGOUT_RESPONSE: "air_logout_response",
    INTERNAL_PROVIDER_REQUEST: "air_internal_provider_request",
    INTERNAL_PROVIDER_RESPONSE: "air_internal_provider_response",
    ADDITIONAL_SIGNER_SIGNATURE_REQUEST: "air_additional_signer_signature_request",
    ADDITIONAL_SIGNER_SIGNATURE_RESPONSE: "air_additional_signer_signature_response",
    REMOVE_SIGNER_SIGNATURE_REQUEST: "air_remove_signer_signature_request",
    REMOVE_SIGNER_SIGNATURE_RESPONSE: "air_remove_signer_signature_response",
};
// Accepts both the bare-string (iframe-init / legacy) and the popup object form.
const isAirServiceStartedMessage = (data) => data === AirWalletMessageTypes.SERVICE_STARTED ||
    (typeof data === "object" &&
        data !== null &&
        "type" in data &&
        data.type === AirWalletMessageTypes.SERVICE_STARTED);

const AirWindowMessageTypes = {
    OPEN_WINDOW_REQUEST: "air_open_window_request",
    OPEN_WINDOW_RESPONSE: "air_open_window_response",
    OPEN_WINDOW_RETRY_REQUEST: "air_open_window_retry_request",
    OPEN_WINDOW_RETRY_RESPONSE: "air_open_window_retry_response",
    WINDOW_CLOSED: "air_window_closed",
};

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

var loglevel$1 = {exports: {}};

/*
* loglevel - https://github.com/pimterry/loglevel
*
* Copyright (c) 2013 Tim Perry
* Licensed under the MIT license.
*/
var loglevel = loglevel$1.exports;

var hasRequiredLoglevel;

function requireLoglevel () {
	if (hasRequiredLoglevel) return loglevel$1.exports;
	hasRequiredLoglevel = 1;
	(function (module) {
		(function (root, definition) {
		    if (module.exports) {
		        module.exports = definition();
		    } else {
		        root.log = definition();
		    }
		}(loglevel, function () {

		    // Slightly dubious tricks to cut down minimized file size
		    var noop = function() {};
		    var undefinedType = "undefined";
		    var isIE = (typeof window !== undefinedType) && (typeof window.navigator !== undefinedType) && (
		        /Trident\/|MSIE /.test(window.navigator.userAgent)
		    );

		    var logMethods = [
		        "trace",
		        "debug",
		        "info",
		        "warn",
		        "error"
		    ];

		    var _loggersByName = {};
		    var defaultLogger = null;

		    // Cross-browser bind equivalent that works at least back to IE6
		    function bindMethod(obj, methodName) {
		        var method = obj[methodName];
		        if (typeof method.bind === 'function') {
		            return method.bind(obj);
		        } else {
		            try {
		                return Function.prototype.bind.call(method, obj);
		            } catch (e) {
		                // Missing bind shim or IE8 + Modernizr, fallback to wrapping
		                return function() {
		                    return Function.prototype.apply.apply(method, [obj, arguments]);
		                };
		            }
		        }
		    }

		    // Trace() doesn't print the message in IE, so for that case we need to wrap it
		    function traceForIE() {
		        if (console.log) {
		            if (console.log.apply) {
		                console.log.apply(console, arguments);
		            } else {
		                // In old IE, native console methods themselves don't have apply().
		                Function.prototype.apply.apply(console.log, [console, arguments]);
		            }
		        }
		        if (console.trace) console.trace();
		    }

		    // Build the best logging method possible for this env
		    // Wherever possible we want to bind, not wrap, to preserve stack traces
		    function realMethod(methodName) {
		        if (methodName === 'debug') {
		            methodName = 'log';
		        }

		        if (typeof console === undefinedType) {
		            return false; // No method possible, for now - fixed later by enableLoggingWhenConsoleArrives
		        } else if (methodName === 'trace' && isIE) {
		            return traceForIE;
		        } else if (console[methodName] !== undefined) {
		            return bindMethod(console, methodName);
		        } else if (console.log !== undefined) {
		            return bindMethod(console, 'log');
		        } else {
		            return noop;
		        }
		    }

		    // These private functions always need `this` to be set properly

		    function replaceLoggingMethods() {
		        /*jshint validthis:true */
		        var level = this.getLevel();

		        // Replace the actual methods.
		        for (var i = 0; i < logMethods.length; i++) {
		            var methodName = logMethods[i];
		            this[methodName] = (i < level) ?
		                noop :
		                this.methodFactory(methodName, level, this.name);
		        }

		        // Define log.log as an alias for log.debug
		        this.log = this.debug;

		        // Return any important warnings.
		        if (typeof console === undefinedType && level < this.levels.SILENT) {
		            return "No console available for logging";
		        }
		    }

		    // In old IE versions, the console isn't present until you first open it.
		    // We build realMethod() replacements here that regenerate logging methods
		    function enableLoggingWhenConsoleArrives(methodName) {
		        return function () {
		            if (typeof console !== undefinedType) {
		                replaceLoggingMethods.call(this);
		                this[methodName].apply(this, arguments);
		            }
		        };
		    }

		    // By default, we use closely bound real methods wherever possible, and
		    // otherwise we wait for a console to appear, and then try again.
		    function defaultMethodFactory(methodName, _level, _loggerName) {
		        /*jshint validthis:true */
		        return realMethod(methodName) ||
		               enableLoggingWhenConsoleArrives.apply(this, arguments);
		    }

		    function Logger(name, factory) {
		      // Private instance variables.
		      var self = this;
		      /**
		       * The level inherited from a parent logger (or a global default). We
		       * cache this here rather than delegating to the parent so that it stays
		       * in sync with the actual logging methods that we have installed (the
		       * parent could change levels but we might not have rebuilt the loggers
		       * in this child yet).
		       * @type {number}
		       */
		      var inheritedLevel;
		      /**
		       * The default level for this logger, if any. If set, this overrides
		       * `inheritedLevel`.
		       * @type {number|null}
		       */
		      var defaultLevel;
		      /**
		       * A user-specific level for this logger. If set, this overrides
		       * `defaultLevel`.
		       * @type {number|null}
		       */
		      var userLevel;

		      var storageKey = "loglevel";
		      if (typeof name === "string") {
		        storageKey += ":" + name;
		      } else if (typeof name === "symbol") {
		        storageKey = undefined;
		      }

		      function persistLevelIfPossible(levelNum) {
		          var levelName = (logMethods[levelNum] || 'silent').toUpperCase();

		          if (typeof window === undefinedType || !storageKey) return;

		          // Use localStorage if available
		          try {
		              window.localStorage[storageKey] = levelName;
		              return;
		          } catch (ignore) {}

		          // Use session cookie as fallback
		          try {
		              window.document.cookie =
		                encodeURIComponent(storageKey) + "=" + levelName + ";";
		          } catch (ignore) {}
		      }

		      function getPersistedLevel() {
		          var storedLevel;

		          if (typeof window === undefinedType || !storageKey) return;

		          try {
		              storedLevel = window.localStorage[storageKey];
		          } catch (ignore) {}

		          // Fallback to cookies if local storage gives us nothing
		          if (typeof storedLevel === undefinedType) {
		              try {
		                  var cookie = window.document.cookie;
		                  var cookieName = encodeURIComponent(storageKey);
		                  var location = cookie.indexOf(cookieName + "=");
		                  if (location !== -1) {
		                      storedLevel = /^([^;]+)/.exec(
		                          cookie.slice(location + cookieName.length + 1)
		                      )[1];
		                  }
		              } catch (ignore) {}
		          }

		          // If the stored level is not valid, treat it as if nothing was stored.
		          if (self.levels[storedLevel] === undefined) {
		              storedLevel = undefined;
		          }

		          return storedLevel;
		      }

		      function clearPersistedLevel() {
		          if (typeof window === undefinedType || !storageKey) return;

		          // Use localStorage if available
		          try {
		              window.localStorage.removeItem(storageKey);
		          } catch (ignore) {}

		          // Use session cookie as fallback
		          try {
		              window.document.cookie =
		                encodeURIComponent(storageKey) + "=; expires=Thu, 01 Jan 1970 00:00:00 UTC";
		          } catch (ignore) {}
		      }

		      function normalizeLevel(input) {
		          var level = input;
		          if (typeof level === "string" && self.levels[level.toUpperCase()] !== undefined) {
		              level = self.levels[level.toUpperCase()];
		          }
		          if (typeof level === "number" && level >= 0 && level <= self.levels.SILENT) {
		              return level;
		          } else {
		              throw new TypeError("log.setLevel() called with invalid level: " + input);
		          }
		      }

		      /*
		       *
		       * Public logger API - see https://github.com/pimterry/loglevel for details
		       *
		       */

		      self.name = name;

		      self.levels = { "TRACE": 0, "DEBUG": 1, "INFO": 2, "WARN": 3,
		          "ERROR": 4, "SILENT": 5};

		      self.methodFactory = factory || defaultMethodFactory;

		      self.getLevel = function () {
		          if (userLevel != null) {
		            return userLevel;
		          } else if (defaultLevel != null) {
		            return defaultLevel;
		          } else {
		            return inheritedLevel;
		          }
		      };

		      self.setLevel = function (level, persist) {
		          userLevel = normalizeLevel(level);
		          if (persist !== false) {  // defaults to true
		              persistLevelIfPossible(userLevel);
		          }

		          // NOTE: in v2, this should call rebuild(), which updates children.
		          return replaceLoggingMethods.call(self);
		      };

		      self.setDefaultLevel = function (level) {
		          defaultLevel = normalizeLevel(level);
		          if (!getPersistedLevel()) {
		              self.setLevel(level, false);
		          }
		      };

		      self.resetLevel = function () {
		          userLevel = null;
		          clearPersistedLevel();
		          replaceLoggingMethods.call(self);
		      };

		      self.enableAll = function(persist) {
		          self.setLevel(self.levels.TRACE, persist);
		      };

		      self.disableAll = function(persist) {
		          self.setLevel(self.levels.SILENT, persist);
		      };

		      self.rebuild = function () {
		          if (defaultLogger !== self) {
		              inheritedLevel = normalizeLevel(defaultLogger.getLevel());
		          }
		          replaceLoggingMethods.call(self);

		          if (defaultLogger === self) {
		              for (var childName in _loggersByName) {
		                _loggersByName[childName].rebuild();
		              }
		          }
		      };

		      // Initialize all the internal levels.
		      inheritedLevel = normalizeLevel(
		          defaultLogger ? defaultLogger.getLevel() : "WARN"
		      );
		      var initialLevel = getPersistedLevel();
		      if (initialLevel != null) {
		          userLevel = normalizeLevel(initialLevel);
		      }
		      replaceLoggingMethods.call(self);
		    }

		    /*
		     *
		     * Top-level API
		     *
		     */

		    defaultLogger = new Logger();

		    defaultLogger.getLogger = function getLogger(name) {
		        if ((typeof name !== "symbol" && typeof name !== "string") || name === "") {
		            throw new TypeError("You must supply a name when creating a logger.");
		        }

		        var logger = _loggersByName[name];
		        if (!logger) {
		            logger = _loggersByName[name] = new Logger(
		                name,
		                defaultLogger.methodFactory
		            );
		        }
		        return logger;
		    };

		    // Grab the current global log variable in case of overwrite
		    var _log = (typeof window !== undefinedType) ? window.log : undefined;
		    defaultLogger.noConflict = function() {
		        if (typeof window !== undefinedType &&
		               window.log === defaultLogger) {
		            window.log = _log;
		        }

		        return defaultLogger;
		    };

		    defaultLogger.getLoggers = function getLoggers() {
		        return _loggersByName;
		    };

		    // ES6 default export, for compatibility
		    defaultLogger['default'] = defaultLogger;

		    return defaultLogger;
		})); 
	} (loglevel$1));
	return loglevel$1.exports;
}

var loglevelExports = requireLoglevel();
var log = /*@__PURE__*/getDefaultExportFromCjs(loglevelExports);

class BaseError extends Error {
    constructor(name, message, options = {}) {
        const { cause, context } = options;
        super(message || name);
        this.name = name;
        this.stack = cause?.stack;
        this.cause = cause;
        this.context = context;
    }
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            context: this.context,
            cause: this.cause,
        };
    }
}
function ensureError(value) {
    if (value instanceof Error)
        return value;
    let stringified = "[Unable to stringify the thrown value]";
    try {
        stringified = JSON.stringify(value);
    }
    catch {
        // ignoring failed stringify
    }
    return new Error(`This value was not thrown as type Error: ${stringified}`);
}

const getLevelName = (levelNum) => {
    const levelNames = Object.keys(log.levels);
    if (levelNum >= 0 && levelNum < levelNames.length) {
        return levelNames[levelNum];
    }
    return "UNKNOWN";
};
const configureLogLevel = (environment, enableLogging) => {
    let level = log.levels.ERROR;
    if (environment === "development") {
        level = enableLogging ? log.levels.TRACE : log.levels.INFO;
    }
    else if (environment === "staging") {
        level = enableLogging ? log.levels.DEBUG : log.levels.INFO;
    }
    else if (environment === "uat" || environment === "sandbox") {
        level = enableLogging ? log.levels.INFO : log.levels.WARN;
    }
    else if (environment === "production") {
        // Be cautious with enabling more than WARN in prod
        level = enableLogging ? log.levels.WARN : log.levels.ERROR;
    }
    log.setLevel(level);
    log.info(`[${window?.location?.href}] LogLevel: ${getLevelName(log.getLevel())}`);
};

const mocaDevnet = {
    id: 5151,
    name: "Moca Devnet",
    nativeCurrency: {
        decimals: 18,
        name: "Moca Network",
        symbol: "MOCA",
    },
    rpcUrls: {
        default: {
            http: ["https://devnet-rpc.mocachain.org"],
            webSocket: ["wss://devnet-rpc.mocachain.org"],
        },
    },
    blockExplorers: {
        default: { name: "Moca Devnet", url: "https://devnet-scan.mocachain.org" },
    },
    contracts: {
        multicall3: {
            address: "0xcA11bde05977b3631167028862bE2a173976CA11",
            blockCreated: 3837540,
        },
    },
    testnet: true,
};
const mocaTestnet = {
    id: 222888,
    name: "Moca Testnet",
    nativeCurrency: {
        decimals: 18,
        name: "Moca Network",
        symbol: "MOCA",
    },
    rpcUrls: {
        default: {
            http: ["https://rpc.testnet.mocachain.dev"],
            webSocket: ["wss://ws.testnet.mocachain.dev"],
        },
    },
    blockExplorers: {
        default: { name: "Moca Testnet", url: "https://testnet-scan.mocachain.org" },
    },
    contracts: {
        multicall3: {
            address: "0xcA11bde05977b3631167028862bE2a173976CA11",
            blockCreated: 1330259,
        },
    },
    testnet: true,
};
const mocaMainnet = {
    id: 2288,
    name: "Moca Mainnet",
    nativeCurrency: {
        decimals: 18,
        name: "Moca Network",
        symbol: "MOCA",
    },
    rpcUrls: {
        default: {
            http: ["https://rpc.mocachain.org"],
            webSocket: ["wss://rpc.mocachain.org/ws"],
        },
    },
    blockExplorers: {
        default: { name: "Moca Mainnet", url: "https://scan.mocachain.org" }, // TODO: need to confirm mainnet explorer
    },
    contracts: {
        multicall3: {
            address: "0xcA11bde05977b3631167028862bE2a173976CA11",
            blockCreated: 3668598,
        },
    },
    testnet: false,
};

const BUILD_ENV = {
    PRODUCTION: "production",
    UAT: "uat",
    STAGING: "staging",
    DEVELOPMENT: "development",
    SANDBOX: "sandbox",
};
const IFRAME_NAME_PREFIX_SET = [
    "air-wallet",
    "air-credential",
    "air-auth",
    "air-recovery",
]; // order defines the z-index from highest to lowest

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
const bigIntReplacer = (_key, value) => {
    return typeof value === "bigint" ? value.toString() : value;
};
/**
 * Creates a window features string for `window.open`, based on the current screen size.
 * It tries to center the window and limits the size to the given max width and height.
 * Slightly reduces the size to avoid browser auto-resizing.
 */
const getWindowFeatures = (maxWidth, maxHeight) => {
    const dualScreenLeft = window.screenLeft !== undefined ? window.screenLeft : window.screenX;
    const dualScreenTop = window.screenTop !== undefined ? window.screenTop : window.screenY;
    const w = window.innerWidth
        ? window.innerWidth
        : document.documentElement.clientWidth
            ? document.documentElement.clientWidth
            : window.screen.width;
    const h = window.innerHeight
        ? window.innerHeight
        : document.documentElement.clientHeight
            ? document.documentElement.clientHeight
            : window.screen.height;
    // 95% adjustment for mobile devices, some browser might resize the window
    const finalWidth = Math.min(w, maxWidth) * 0.95;
    const finalHeight = Math.min(h, maxHeight) * 0.95;
    const systemZoom = 1; // No reliable estimate
    const left = Math.abs((w - finalWidth) / 2 / systemZoom + dualScreenLeft);
    const top = Math.abs((h - finalHeight) / 2 / systemZoom + dualScreenTop);
    return `titlebar=0,toolbar=0,status=0,location=0,menubar=0,height=${finalHeight / systemZoom},width=${finalWidth / systemZoom},top=${top},left=${left}`;
};

const FONT_CDNS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];
const PRODUCTION_MAINNET_URLS = {
    authUrl: "https://account-mainnet.air3.com/auth/",
    walletUrl: "https://account-mainnet.air3.com/wallet/",
    recoveryUrl: "https://account-mainnet.air3.com/recovery/",
    credentialUrl: "https://account-mainnet.air3.com/credential/",
};
const AIR_URLS = {
    [BUILD_ENV.DEVELOPMENT]: {
        authUrl: "https://localhost:8200/auth/",
        walletUrl: "https://localhost:8200/wallet/",
        recoveryUrl: "https://localhost:8200/recovery/",
        credentialUrl: "https://localhost:8200/credential/",
    },
    [BUILD_ENV.STAGING]: {
        authUrl: "https://account.staging.air3.com/auth/",
        walletUrl: "https://account.staging.air3.com/wallet/",
        recoveryUrl: "https://account.staging.air3.com/recovery/",
        credentialUrl: "https://account.staging.air3.com/credential/",
    },
    [BUILD_ENV.UAT]: {
        authUrl: "https://account.uat.air3.com/auth/",
        walletUrl: "https://account.uat.air3.com/wallet/",
        recoveryUrl: "https://account.uat.air3.com/recovery/",
        credentialUrl: "https://account.uat.air3.com/credential/",
    },
    [BUILD_ENV.SANDBOX]: {
        authUrl: "https://account.sandbox-testnet.air3.com/auth/",
        walletUrl: "https://account.sandbox-testnet.air3.com/wallet/",
        recoveryUrl: "https://account.sandbox-testnet.air3.com/recovery/",
        credentialUrl: "https://account.sandbox-testnet.air3.com/credential/",
    },
    [BUILD_ENV.PRODUCTION]: {
        authUrl: "https://account.air3.com/auth/",
        walletUrl: "https://account.air3.com/wallet/",
        recoveryUrl: "https://account.air3.com/recovery/",
        credentialUrl: "https://account.air3.com/credential/",
    },
};
const getAirUrls = (buildEnv, credentialNetwork) => {
    if (buildEnv === BUILD_ENV.PRODUCTION && credentialNetwork === "mainnet") {
        return PRODUCTION_MAINNET_URLS;
    }
    return AIR_URLS[buildEnv];
};
/**
 * Injects dns-prefetch, preconnect, and prefetch link tags
 * for a given resource or page URL.
 *
 * @param url - Full resource URL (e.g. "https://cdn.example.com/app.js")
 * @param options - Optional configuration
 *   prefetch?: boolean — disable if you only want connection warm-up
 *   as?: string — specify resource type for prefetch ("document", "script", "style", "font", etc.)
 */
const addResourceHints = (url, options) => {
    try {
        const parsed = new URL(url, window.location.href);
        const isCrossOrigin = parsed.origin !== window.location.origin;
        const head = document.head;
        const addLink = (rel, href, as, crossOrigin) => {
            // Skip if a matching link already exists
            if (head.querySelector(`link[rel="${rel}"][href="${href}"]`))
                return;
            const link = document.createElement("link");
            link.rel = rel;
            link.href = href;
            if (as)
                ;
            if (crossOrigin)
                link.crossOrigin = "anonymous";
            head.appendChild(link);
        };
        const hostname = parsed.hostname;
        // DNS Prefetch (scheme-less, safe for any protocol)
        addLink("dns-prefetch", `//${hostname}`);
        // Preconnect (TCP + TLS warm-up)
        addLink("preconnect", parsed.origin, undefined, isCrossOrigin);
        // Prefetch (optional — caches the resource or HTML document)
        if (options?.prefetch !== false &&
            HTMLScriptElement.supports &&
            HTMLScriptElement.supports("speculationrules")) {
            const scriptId = `speculation-${btoa(parsed.href)
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=/g, "")}`;
            if (!document.getElementById(scriptId)) {
                const script = document.createElement("script");
                script.id = scriptId;
                script.type = "speculationrules";
                const sources = [
                    {
                        source: "list",
                        urls: [parsed.href],
                        eagerness: "immediate",
                    },
                ];
                const rules = {
                    ...((options?.as ?? "document") === "document"
                        ? { prerender: sources }
                        : { prefetch: sources }),
                };
                script.textContent = JSON.stringify(rules);
                document.body.appendChild(script);
            }
        }
    }
    catch (err) {
        log.warn("[addResourceHints] Invalid URL:", url, err);
    }
};
const isElement = (element) => element instanceof Element || element instanceof Document;
const extractErrorHash = (message) => {
    if (!message)
        return "";
    // Format: "reason: 0x..."
    if (message.includes("reason:")) {
        const match = message.match(/reason:\s*(0x[a-fA-F0-9]+)/);
        return match ? match[1].trim() : "";
    }
    // Format: "UserOperation reverted during simulation with reason: 0x..."
    if (message.includes("with reason:")) {
        const match = message.match(/with reason:\s*(0x[a-fA-F0-9]+)/);
        return match ? match[1].trim() : "";
    }
    // Look for any 0x pattern that could be a hash
    const hexMatch = message.match(/(0x[a-fA-F0-9]{8,})/);
    return hexMatch ? hexMatch[1].trim() : "";
};

class AirServiceError extends BaseError {
    static from(error) {
        if (error instanceof AirServiceError) {
            return error;
        }
        else if (error instanceof Object && "message" in error) {
            if (error.message === "User cancelled login") {
                return new AirServiceError("USER_CANCELLED", error.message);
            }
            return new AirServiceError("UNKNOWN_ERROR", String(error.message));
        }
        return new AirServiceError("UNKNOWN_ERROR");
    }
}
class ProviderRpcError extends Error {
    constructor(message) {
        super(message);
        this.metaMessages = [];
    }
}
class UserRejectedRequestError extends ProviderRpcError {
    constructor() {
        super(...arguments);
        this.code = 4001;
        this.name = "UserRejectedRequestError";
    }
}
class UnauthorizedProviderError extends ProviderRpcError {
    constructor() {
        super(...arguments);
        this.code = 4100;
        this.name = "UnauthorizedProviderError";
    }
}
class UnsupportedProviderMethodError extends ProviderRpcError {
    constructor() {
        super(...arguments);
        this.code = 4200;
        this.name = "UnsupportedProviderMethodError";
    }
}
class ProviderDisconnectedError extends ProviderRpcError {
    constructor() {
        super(...arguments);
        this.code = 4900;
        this.name = "ProviderDisconnectedError";
    }
}
class ChainDisconnectedError extends ProviderRpcError {
    constructor() {
        super(...arguments);
        this.code = 4901;
        this.name = "ChainDisconnectedError";
    }
}
class SwitchChainError extends ProviderRpcError {
    constructor() {
        super(...arguments);
        this.code = 4902;
        this.name = "SwitchChainError";
    }
}
class TransactionRejectedRpcError extends ProviderRpcError {
    constructor(message) {
        // Remove the "Version: viem@x.x.x" suffix if present
        const cleanMessage = message.replace(/\nVersion:.*$/, "");
        super(cleanMessage);
        this.code = -32003;
        this.name = "TransactionRejectedRpcError";
        // Parse the error hash from the message
        this.metaMessages.push(extractErrorHash(cleanMessage));
    }
}
class InvalidRequestRpcError extends ProviderRpcError {
    constructor() {
        super(...arguments);
        this.code = -32600;
        this.name = "InvalidRequestRpcError";
    }
}
class MethodNotFoundRpcError extends ProviderRpcError {
    constructor() {
        super(...arguments);
        this.code = -32601;
        this.name = "MethodNotFoundRpcError";
    }
}
class InvalidParamsRpcError extends ProviderRpcError {
    constructor() {
        super(...arguments);
        this.code = -32602;
        this.name = "InvalidParamsRpcError";
    }
}
class InternalRpcError extends ProviderRpcError {
    constructor() {
        super(...arguments);
        this.code = -32603;
        this.name = "InternalRpcError";
    }
}
function ensureProviderRpcError(value) {
    if (value instanceof ProviderRpcError) {
        return value;
    }
    if (typeof value === "object" &&
        value !== null &&
        "errorCode" in value &&
        "errorMessage" in value) {
        if (typeof value.errorCode === "number" && typeof value.errorMessage === "string") {
            switch (value.errorCode) {
                case 4001:
                    return new UserRejectedRequestError(value.errorMessage);
                case 4100:
                    return new UnauthorizedProviderError(value.errorMessage);
                case 4200:
                    return new UnsupportedProviderMethodError(value.errorMessage);
                case 4900:
                    return new ProviderDisconnectedError(value.errorMessage);
                case 4901:
                    return new ChainDisconnectedError(value.errorMessage);
                case 4902:
                    return new SwitchChainError(value.errorMessage);
                case -32003:
                    return new TransactionRejectedRpcError(value.errorMessage);
            }
        }
    }
    let stringified = "[Unable to stringify the thrown value]";
    try {
        stringified = JSON.stringify(value);
    }
    catch {
        // ignoring failed stringify
    }
    return new InternalRpcError(`Invalid value for ProviderRpcError: ${stringified}`);
}

function isFunction(value) {
    return typeof value === 'function';
}

function createErrorClass(createImpl) {
    var _super = function (instance) {
        Error.call(instance);
        instance.stack = new Error().stack;
    };
    var ctorFunc = createImpl(_super);
    ctorFunc.prototype = Object.create(Error.prototype);
    ctorFunc.prototype.constructor = ctorFunc;
    return ctorFunc;
}

var UnsubscriptionError = createErrorClass(function (_super) {
    return function UnsubscriptionErrorImpl(errors) {
        _super(this);
        this.message = errors
            ? errors.length + " errors occurred during unsubscription:\n" + errors.map(function (err, i) { return i + 1 + ") " + err.toString(); }).join('\n  ')
            : '';
        this.name = 'UnsubscriptionError';
        this.errors = errors;
    };
});

function arrRemove(arr, item) {
    if (arr) {
        var index = arr.indexOf(item);
        0 <= index && arr.splice(index, 1);
    }
}

var Subscription = (function () {
    function Subscription(initialTeardown) {
        this.initialTeardown = initialTeardown;
        this.closed = false;
        this._parentage = null;
        this._finalizers = null;
    }
    Subscription.prototype.unsubscribe = function () {
        var e_1, _a, e_2, _b;
        var errors;
        if (!this.closed) {
            this.closed = true;
            var _parentage = this._parentage;
            if (_parentage) {
                this._parentage = null;
                if (Array.isArray(_parentage)) {
                    try {
                        for (var _parentage_1 = __values(_parentage), _parentage_1_1 = _parentage_1.next(); !_parentage_1_1.done; _parentage_1_1 = _parentage_1.next()) {
                            var parent_1 = _parentage_1_1.value;
                            parent_1.remove(this);
                        }
                    }
                    catch (e_1_1) { e_1 = { error: e_1_1 }; }
                    finally {
                        try {
                            if (_parentage_1_1 && !_parentage_1_1.done && (_a = _parentage_1.return)) _a.call(_parentage_1);
                        }
                        finally { if (e_1) throw e_1.error; }
                    }
                }
                else {
                    _parentage.remove(this);
                }
            }
            var initialFinalizer = this.initialTeardown;
            if (isFunction(initialFinalizer)) {
                try {
                    initialFinalizer();
                }
                catch (e) {
                    errors = e instanceof UnsubscriptionError ? e.errors : [e];
                }
            }
            var _finalizers = this._finalizers;
            if (_finalizers) {
                this._finalizers = null;
                try {
                    for (var _finalizers_1 = __values(_finalizers), _finalizers_1_1 = _finalizers_1.next(); !_finalizers_1_1.done; _finalizers_1_1 = _finalizers_1.next()) {
                        var finalizer = _finalizers_1_1.value;
                        try {
                            execFinalizer(finalizer);
                        }
                        catch (err) {
                            errors = errors !== null && errors !== void 0 ? errors : [];
                            if (err instanceof UnsubscriptionError) {
                                errors = __spreadArray(__spreadArray([], __read(errors)), __read(err.errors));
                            }
                            else {
                                errors.push(err);
                            }
                        }
                    }
                }
                catch (e_2_1) { e_2 = { error: e_2_1 }; }
                finally {
                    try {
                        if (_finalizers_1_1 && !_finalizers_1_1.done && (_b = _finalizers_1.return)) _b.call(_finalizers_1);
                    }
                    finally { if (e_2) throw e_2.error; }
                }
            }
            if (errors) {
                throw new UnsubscriptionError(errors);
            }
        }
    };
    Subscription.prototype.add = function (teardown) {
        var _a;
        if (teardown && teardown !== this) {
            if (this.closed) {
                execFinalizer(teardown);
            }
            else {
                if (teardown instanceof Subscription) {
                    if (teardown.closed || teardown._hasParent(this)) {
                        return;
                    }
                    teardown._addParent(this);
                }
                (this._finalizers = (_a = this._finalizers) !== null && _a !== void 0 ? _a : []).push(teardown);
            }
        }
    };
    Subscription.prototype._hasParent = function (parent) {
        var _parentage = this._parentage;
        return _parentage === parent || (Array.isArray(_parentage) && _parentage.includes(parent));
    };
    Subscription.prototype._addParent = function (parent) {
        var _parentage = this._parentage;
        this._parentage = Array.isArray(_parentage) ? (_parentage.push(parent), _parentage) : _parentage ? [_parentage, parent] : parent;
    };
    Subscription.prototype._removeParent = function (parent) {
        var _parentage = this._parentage;
        if (_parentage === parent) {
            this._parentage = null;
        }
        else if (Array.isArray(_parentage)) {
            arrRemove(_parentage, parent);
        }
    };
    Subscription.prototype.remove = function (teardown) {
        var _finalizers = this._finalizers;
        _finalizers && arrRemove(_finalizers, teardown);
        if (teardown instanceof Subscription) {
            teardown._removeParent(this);
        }
    };
    Subscription.EMPTY = (function () {
        var empty = new Subscription();
        empty.closed = true;
        return empty;
    })();
    return Subscription;
}());
var EMPTY_SUBSCRIPTION = Subscription.EMPTY;
function isSubscription(value) {
    return (value instanceof Subscription ||
        (value && 'closed' in value && isFunction(value.remove) && isFunction(value.add) && isFunction(value.unsubscribe)));
}
function execFinalizer(finalizer) {
    if (isFunction(finalizer)) {
        finalizer();
    }
    else {
        finalizer.unsubscribe();
    }
}

var config = {
    Promise: undefined};

var timeoutProvider = {
    setTimeout: function (handler, timeout) {
        var args = [];
        for (var _i = 2; _i < arguments.length; _i++) {
            args[_i - 2] = arguments[_i];
        }
        return setTimeout.apply(void 0, __spreadArray([handler, timeout], __read(args)));
    },
    clearTimeout: function (handle) {
        return (clearTimeout)(handle);
    },
    delegate: undefined,
};

function reportUnhandledError(err) {
    timeoutProvider.setTimeout(function () {
        {
            throw err;
        }
    });
}

function noop() { }

function errorContext(cb) {
    {
        cb();
    }
}

var Subscriber = (function (_super) {
    __extends(Subscriber, _super);
    function Subscriber(destination) {
        var _this = _super.call(this) || this;
        _this.isStopped = false;
        if (destination) {
            _this.destination = destination;
            if (isSubscription(destination)) {
                destination.add(_this);
            }
        }
        else {
            _this.destination = EMPTY_OBSERVER;
        }
        return _this;
    }
    Subscriber.create = function (next, error, complete) {
        return new SafeSubscriber(next, error, complete);
    };
    Subscriber.prototype.next = function (value) {
        if (this.isStopped) ;
        else {
            this._next(value);
        }
    };
    Subscriber.prototype.error = function (err) {
        if (this.isStopped) ;
        else {
            this.isStopped = true;
            this._error(err);
        }
    };
    Subscriber.prototype.complete = function () {
        if (this.isStopped) ;
        else {
            this.isStopped = true;
            this._complete();
        }
    };
    Subscriber.prototype.unsubscribe = function () {
        if (!this.closed) {
            this.isStopped = true;
            _super.prototype.unsubscribe.call(this);
            this.destination = null;
        }
    };
    Subscriber.prototype._next = function (value) {
        this.destination.next(value);
    };
    Subscriber.prototype._error = function (err) {
        try {
            this.destination.error(err);
        }
        finally {
            this.unsubscribe();
        }
    };
    Subscriber.prototype._complete = function () {
        try {
            this.destination.complete();
        }
        finally {
            this.unsubscribe();
        }
    };
    return Subscriber;
}(Subscription));
var ConsumerObserver = (function () {
    function ConsumerObserver(partialObserver) {
        this.partialObserver = partialObserver;
    }
    ConsumerObserver.prototype.next = function (value) {
        var partialObserver = this.partialObserver;
        if (partialObserver.next) {
            try {
                partialObserver.next(value);
            }
            catch (error) {
                handleUnhandledError(error);
            }
        }
    };
    ConsumerObserver.prototype.error = function (err) {
        var partialObserver = this.partialObserver;
        if (partialObserver.error) {
            try {
                partialObserver.error(err);
            }
            catch (error) {
                handleUnhandledError(error);
            }
        }
        else {
            handleUnhandledError(err);
        }
    };
    ConsumerObserver.prototype.complete = function () {
        var partialObserver = this.partialObserver;
        if (partialObserver.complete) {
            try {
                partialObserver.complete();
            }
            catch (error) {
                handleUnhandledError(error);
            }
        }
    };
    return ConsumerObserver;
}());
var SafeSubscriber = (function (_super) {
    __extends(SafeSubscriber, _super);
    function SafeSubscriber(observerOrNext, error, complete) {
        var _this = _super.call(this) || this;
        var partialObserver;
        if (isFunction(observerOrNext) || !observerOrNext) {
            partialObserver = {
                next: (observerOrNext !== null && observerOrNext !== void 0 ? observerOrNext : undefined),
                error: error !== null && error !== void 0 ? error : undefined,
                complete: complete !== null && complete !== void 0 ? complete : undefined,
            };
        }
        else {
            {
                partialObserver = observerOrNext;
            }
        }
        _this.destination = new ConsumerObserver(partialObserver);
        return _this;
    }
    return SafeSubscriber;
}(Subscriber));
function handleUnhandledError(error) {
    {
        reportUnhandledError(error);
    }
}
function defaultErrorHandler(err) {
    throw err;
}
var EMPTY_OBSERVER = {
    closed: true,
    next: noop,
    error: defaultErrorHandler,
    complete: noop,
};

var observable = (function () { return (typeof Symbol === 'function' && Symbol.observable) || '@@observable'; })();

function identity(x) {
    return x;
}

function pipeFromArray(fns) {
    if (fns.length === 0) {
        return identity;
    }
    if (fns.length === 1) {
        return fns[0];
    }
    return function piped(input) {
        return fns.reduce(function (prev, fn) { return fn(prev); }, input);
    };
}

var Observable = (function () {
    function Observable(subscribe) {
        if (subscribe) {
            this._subscribe = subscribe;
        }
    }
    Observable.prototype.lift = function (operator) {
        var observable = new Observable();
        observable.source = this;
        observable.operator = operator;
        return observable;
    };
    Observable.prototype.subscribe = function (observerOrNext, error, complete) {
        var _this = this;
        var subscriber = isSubscriber(observerOrNext) ? observerOrNext : new SafeSubscriber(observerOrNext, error, complete);
        errorContext(function () {
            var _a = _this, operator = _a.operator, source = _a.source;
            subscriber.add(operator
                ?
                    operator.call(subscriber, source)
                : source
                    ?
                        _this._subscribe(subscriber)
                    :
                        _this._trySubscribe(subscriber));
        });
        return subscriber;
    };
    Observable.prototype._trySubscribe = function (sink) {
        try {
            return this._subscribe(sink);
        }
        catch (err) {
            sink.error(err);
        }
    };
    Observable.prototype.forEach = function (next, promiseCtor) {
        var _this = this;
        promiseCtor = getPromiseCtor(promiseCtor);
        return new promiseCtor(function (resolve, reject) {
            var subscriber = new SafeSubscriber({
                next: function (value) {
                    try {
                        next(value);
                    }
                    catch (err) {
                        reject(err);
                        subscriber.unsubscribe();
                    }
                },
                error: reject,
                complete: resolve,
            });
            _this.subscribe(subscriber);
        });
    };
    Observable.prototype._subscribe = function (subscriber) {
        var _a;
        return (_a = this.source) === null || _a === void 0 ? void 0 : _a.subscribe(subscriber);
    };
    Observable.prototype[observable] = function () {
        return this;
    };
    Observable.prototype.pipe = function () {
        var operations = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            operations[_i] = arguments[_i];
        }
        return pipeFromArray(operations)(this);
    };
    Observable.prototype.toPromise = function (promiseCtor) {
        var _this = this;
        promiseCtor = getPromiseCtor(promiseCtor);
        return new promiseCtor(function (resolve, reject) {
            var value;
            _this.subscribe(function (x) { return (value = x); }, function (err) { return reject(err); }, function () { return resolve(value); });
        });
    };
    Observable.create = function (subscribe) {
        return new Observable(subscribe);
    };
    return Observable;
}());
function getPromiseCtor(promiseCtor) {
    var _a;
    return (_a = promiseCtor !== null && promiseCtor !== void 0 ? promiseCtor : config.Promise) !== null && _a !== void 0 ? _a : Promise;
}
function isObserver(value) {
    return value && isFunction(value.next) && isFunction(value.error) && isFunction(value.complete);
}
function isSubscriber(value) {
    return (value && value instanceof Subscriber) || (isObserver(value) && isSubscription(value));
}

function hasLift(source) {
    return isFunction(source === null || source === void 0 ? void 0 : source.lift);
}
function operate(init) {
    return function (source) {
        if (hasLift(source)) {
            return source.lift(function (liftedSource) {
                try {
                    return init(liftedSource, this);
                }
                catch (err) {
                    this.error(err);
                }
            });
        }
        throw new TypeError('Unable to lift unknown Observable type');
    };
}

function createOperatorSubscriber(destination, onNext, onComplete, onError, onFinalize) {
    return new OperatorSubscriber(destination, onNext, onComplete, onError, onFinalize);
}
var OperatorSubscriber = (function (_super) {
    __extends(OperatorSubscriber, _super);
    function OperatorSubscriber(destination, onNext, onComplete, onError, onFinalize, shouldUnsubscribe) {
        var _this = _super.call(this, destination) || this;
        _this.onFinalize = onFinalize;
        _this.shouldUnsubscribe = shouldUnsubscribe;
        _this._next = onNext
            ? function (value) {
                try {
                    onNext(value);
                }
                catch (err) {
                    destination.error(err);
                }
            }
            : _super.prototype._next;
        _this._error = onError
            ? function (err) {
                try {
                    onError(err);
                }
                catch (err) {
                    destination.error(err);
                }
                finally {
                    this.unsubscribe();
                }
            }
            : _super.prototype._error;
        _this._complete = onComplete
            ? function () {
                try {
                    onComplete();
                }
                catch (err) {
                    destination.error(err);
                }
                finally {
                    this.unsubscribe();
                }
            }
            : _super.prototype._complete;
        return _this;
    }
    OperatorSubscriber.prototype.unsubscribe = function () {
        var _a;
        if (!this.shouldUnsubscribe || this.shouldUnsubscribe()) {
            var closed_1 = this.closed;
            _super.prototype.unsubscribe.call(this);
            !closed_1 && ((_a = this.onFinalize) === null || _a === void 0 ? void 0 : _a.call(this));
        }
    };
    return OperatorSubscriber;
}(Subscriber));

var ObjectUnsubscribedError = createErrorClass(function (_super) {
    return function ObjectUnsubscribedErrorImpl() {
        _super(this);
        this.name = 'ObjectUnsubscribedError';
        this.message = 'object unsubscribed';
    };
});

var Subject = (function (_super) {
    __extends(Subject, _super);
    function Subject() {
        var _this = _super.call(this) || this;
        _this.closed = false;
        _this.currentObservers = null;
        _this.observers = [];
        _this.isStopped = false;
        _this.hasError = false;
        _this.thrownError = null;
        return _this;
    }
    Subject.prototype.lift = function (operator) {
        var subject = new AnonymousSubject(this, this);
        subject.operator = operator;
        return subject;
    };
    Subject.prototype._throwIfClosed = function () {
        if (this.closed) {
            throw new ObjectUnsubscribedError();
        }
    };
    Subject.prototype.next = function (value) {
        var _this = this;
        errorContext(function () {
            var e_1, _a;
            _this._throwIfClosed();
            if (!_this.isStopped) {
                if (!_this.currentObservers) {
                    _this.currentObservers = Array.from(_this.observers);
                }
                try {
                    for (var _b = __values(_this.currentObservers), _c = _b.next(); !_c.done; _c = _b.next()) {
                        var observer = _c.value;
                        observer.next(value);
                    }
                }
                catch (e_1_1) { e_1 = { error: e_1_1 }; }
                finally {
                    try {
                        if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
                    }
                    finally { if (e_1) throw e_1.error; }
                }
            }
        });
    };
    Subject.prototype.error = function (err) {
        var _this = this;
        errorContext(function () {
            _this._throwIfClosed();
            if (!_this.isStopped) {
                _this.hasError = _this.isStopped = true;
                _this.thrownError = err;
                var observers = _this.observers;
                while (observers.length) {
                    observers.shift().error(err);
                }
            }
        });
    };
    Subject.prototype.complete = function () {
        var _this = this;
        errorContext(function () {
            _this._throwIfClosed();
            if (!_this.isStopped) {
                _this.isStopped = true;
                var observers = _this.observers;
                while (observers.length) {
                    observers.shift().complete();
                }
            }
        });
    };
    Subject.prototype.unsubscribe = function () {
        this.isStopped = this.closed = true;
        this.observers = this.currentObservers = null;
    };
    Object.defineProperty(Subject.prototype, "observed", {
        get: function () {
            var _a;
            return ((_a = this.observers) === null || _a === void 0 ? void 0 : _a.length) > 0;
        },
        enumerable: false,
        configurable: true
    });
    Subject.prototype._trySubscribe = function (subscriber) {
        this._throwIfClosed();
        return _super.prototype._trySubscribe.call(this, subscriber);
    };
    Subject.prototype._subscribe = function (subscriber) {
        this._throwIfClosed();
        this._checkFinalizedStatuses(subscriber);
        return this._innerSubscribe(subscriber);
    };
    Subject.prototype._innerSubscribe = function (subscriber) {
        var _this = this;
        var _a = this, hasError = _a.hasError, isStopped = _a.isStopped, observers = _a.observers;
        if (hasError || isStopped) {
            return EMPTY_SUBSCRIPTION;
        }
        this.currentObservers = null;
        observers.push(subscriber);
        return new Subscription(function () {
            _this.currentObservers = null;
            arrRemove(observers, subscriber);
        });
    };
    Subject.prototype._checkFinalizedStatuses = function (subscriber) {
        var _a = this, hasError = _a.hasError, thrownError = _a.thrownError, isStopped = _a.isStopped;
        if (hasError) {
            subscriber.error(thrownError);
        }
        else if (isStopped) {
            subscriber.complete();
        }
    };
    Subject.prototype.asObservable = function () {
        var observable = new Observable();
        observable.source = this;
        return observable;
    };
    Subject.create = function (destination, source) {
        return new AnonymousSubject(destination, source);
    };
    return Subject;
}(Observable));
var AnonymousSubject = (function (_super) {
    __extends(AnonymousSubject, _super);
    function AnonymousSubject(destination, source) {
        var _this = _super.call(this) || this;
        _this.destination = destination;
        _this.source = source;
        return _this;
    }
    AnonymousSubject.prototype.next = function (value) {
        var _a, _b;
        (_b = (_a = this.destination) === null || _a === void 0 ? void 0 : _a.next) === null || _b === void 0 ? void 0 : _b.call(_a, value);
    };
    AnonymousSubject.prototype.error = function (err) {
        var _a, _b;
        (_b = (_a = this.destination) === null || _a === void 0 ? void 0 : _a.error) === null || _b === void 0 ? void 0 : _b.call(_a, err);
    };
    AnonymousSubject.prototype.complete = function () {
        var _a, _b;
        (_b = (_a = this.destination) === null || _a === void 0 ? void 0 : _a.complete) === null || _b === void 0 ? void 0 : _b.call(_a);
    };
    AnonymousSubject.prototype._subscribe = function (subscriber) {
        var _a, _b;
        return (_b = (_a = this.source) === null || _a === void 0 ? void 0 : _a.subscribe(subscriber)) !== null && _b !== void 0 ? _b : EMPTY_SUBSCRIPTION;
    };
    return AnonymousSubject;
}(Subject));

var BehaviorSubject = (function (_super) {
    __extends(BehaviorSubject, _super);
    function BehaviorSubject(_value) {
        var _this = _super.call(this) || this;
        _this._value = _value;
        return _this;
    }
    Object.defineProperty(BehaviorSubject.prototype, "value", {
        get: function () {
            return this.getValue();
        },
        enumerable: false,
        configurable: true
    });
    BehaviorSubject.prototype._subscribe = function (subscriber) {
        var subscription = _super.prototype._subscribe.call(this, subscriber);
        !subscription.closed && subscriber.next(this._value);
        return subscription;
    };
    BehaviorSubject.prototype.getValue = function () {
        var _a = this, hasError = _a.hasError, thrownError = _a.thrownError, _value = _a._value;
        if (hasError) {
            throw thrownError;
        }
        this._throwIfClosed();
        return _value;
    };
    BehaviorSubject.prototype.next = function (value) {
        _super.prototype.next.call(this, (this._value = value));
    };
    return BehaviorSubject;
}(Subject));

var EmptyError = createErrorClass(function (_super) {
    return function EmptyErrorImpl() {
        _super(this);
        this.name = 'EmptyError';
        this.message = 'no elements in sequence';
    };
});

function firstValueFrom(source, config) {
    return new Promise(function (resolve, reject) {
        var subscriber = new SafeSubscriber({
            next: function (value) {
                resolve(value);
                subscriber.unsubscribe();
            },
            error: reject,
            complete: function () {
                {
                    reject(new EmptyError());
                }
            },
        });
        source.subscribe(subscriber);
    });
}

function map(project, thisArg) {
    return operate(function (source, subscriber) {
        var index = 0;
        source.subscribe(createOperatorSubscriber(subscriber, function (value) {
            subscriber.next(project.call(thisArg, value, index++));
        }));
    });
}

function filter(predicate, thisArg) {
    return operate(function (source, subscriber) {
        var index = 0;
        source.subscribe(createOperatorSubscriber(subscriber, function (value) { return predicate.call(thisArg, value, index++) && subscriber.next(value); }));
    });
}

// refer to realm-network-api/src/common/enums/error-codes.enum.ts
/*** Authentication Errors ***/
var AuthErrorName;
(function (AuthErrorName) {
    AuthErrorName["UNAUTHORIZED"] = "UNAUTHORIZED";
    AuthErrorName["INVALID_TOKEN"] = "INVALID_TOKEN";
    AuthErrorName["TOKEN_EXPIRED"] = "TOKEN_EXPIRED";
    AuthErrorName["INVALID_CREDENTIALS"] = "INVALID_CREDENTIALS";
})(AuthErrorName || (AuthErrorName = {}));
/*** Partner Access Token Errors ***/
var PartnerAccessTokenErrorName;
(function (PartnerAccessTokenErrorName) {
    PartnerAccessTokenErrorName["PARTNER_ACCESS_TOKEN_INVALID"] = "PARTNER_ACCESS_TOKEN_INVALID";
    PartnerAccessTokenErrorName["USER_MISMATCH"] = "USER_MISMATCH";
    /** dApp-supplied partner JWT is past its `exp` — SDK consumers should mint a fresh one. */
    PartnerAccessTokenErrorName["PARTNER_TOKEN_EXPIRED"] = "PARTNER_TOKEN_EXPIRED";
})(PartnerAccessTokenErrorName || (PartnerAccessTokenErrorName = {}));
/*** Realm ID Errors ***/
var RealmIDErrorName;
(function (RealmIDErrorName) {
    RealmIDErrorName["REALM_ID_NOT_FOUND"] = "REALM_ID_NOT_FOUND";
    RealmIDErrorName["REALM_ID_INVALID_NAME"] = "REALM_ID_INVALID_NAME";
    RealmIDErrorName["REALM_ID_ALREADY_EXISTS"] = "REALM_ID_ALREADY_EXISTS";
    RealmIDErrorName["REALM_ID_DUPLICATE_PARTNER_USER"] = "REALM_ID_DUPLICATE_PARTNER_USER";
})(RealmIDErrorName || (RealmIDErrorName = {}));
/*** Parameter Errors ***/
var ParameterErrorName;
(function (ParameterErrorName) {
    ParameterErrorName["INVALID_PARAMETER"] = "INVALID_PARAMETER";
})(ParameterErrorName || (ParameterErrorName = {}));
/*** Server Errors ***/
var ServerErrorName;
(function (ServerErrorName) {
    ServerErrorName["INTERNAL_SERVER_ERROR"] = "INTERNAL_SERVER_ERROR";
})(ServerErrorName || (ServerErrorName = {}));
/*** Passkey Errors ***/
var PasskeyErrorName;
(function (PasskeyErrorName) {
    PasskeyErrorName["PASSKEY_REGISTRATION_FAILED"] = "PASSKEY_REGISTRATION_FAILED";
    PasskeyErrorName["PASSKEY_AUTHENTICATION_FAILED"] = "PASSKEY_AUTHENTICATION_FAILED";
    PasskeyErrorName["PASSKEY_LIMIT_EXCEEDED"] = "PASSKEY_LIMIT_EXCEEDED";
    PasskeyErrorName["PASSKEY_NOT_FOUND"] = "PASSKEY_NOT_FOUND";
    PasskeyErrorName["PASSKEY_UNAUTHORIZED"] = "PASSKEY_UNAUTHORIZED";
    PasskeyErrorName["PASSKEY_CHALLENGE_INVALID"] = "PASSKEY_CHALLENGE_INVALID";
})(PasskeyErrorName || (PasskeyErrorName = {}));
/*** Passwordless Authentication Errors ***/
var PasswordlessErrorName;
(function (PasswordlessErrorName) {
    PasswordlessErrorName["PASSWORDLESS_CODE_EXPIRED"] = "PASSWORDLESS_CODE_EXPIRED";
    PasswordlessErrorName["PASSWORDLESS_INVALID_CODE"] = "PASSWORDLESS_INVALID_CODE";
    PasswordlessErrorName["PASSWORDLESS_MAX_ATTEMPTS"] = "PASSWORDLESS_MAX_ATTEMPTS";
    PasswordlessErrorName["PASSWORDLESS_HOURLY_LIMIT"] = "PASSWORDLESS_HOURLY_LIMIT";
    PasswordlessErrorName["PASSWORDLESS_LOCK_EXCEEDED"] = "PASSWORDLESS_LOCK_EXCEEDED";
    PasswordlessErrorName["CAPTCHA_TOKEN_VERIFICATION_FAILED"] = "CAPTCHA_TOKEN_VERIFICATION_FAILED";
    PasswordlessErrorName["CAPTCHA_TOKEN_INVALID"] = "CAPTCHA_TOKEN_INVALID";
    PasswordlessErrorName["CAPTCHA_SECRET_MISSING"] = "CAPTCHA_SECRET_MISSING";
    PasswordlessErrorName["CAPTCHA_TOKEN_MISSING"] = "CAPTCHA_TOKEN_MISSING";
})(PasswordlessErrorName || (PasswordlessErrorName = {}));
/*** Authentication Wallet Errors ***/
var AuthWalletErrorName;
(function (AuthWalletErrorName) {
    AuthWalletErrorName["AUTH_WALLET_LOCK_EXCEEDED"] = "AUTH_WALLET_LOCK_EXCEEDED";
    AuthWalletErrorName["AUTH_WALLET_NONCE_EXPIRED_OR_INVALID"] = "AUTH_WALLET_NONCE_EXPIRED_OR_INVALID";
    AuthWalletErrorName["AUTH_WALLET_ADDRESS_MISMATCH"] = "AUTH_WALLET_ADDRESS_MISMATCH";
    AuthWalletErrorName["AUTH_WALLET_SIGNATURE_VERIFICATION_FAILED"] = "AUTH_WALLET_SIGNATURE_VERIFICATION_FAILED";
})(AuthWalletErrorName || (AuthWalletErrorName = {}));
/*** Wallet Linking Errors ***/
var WalletLinkErrorName;
(function (WalletLinkErrorName) {
    WalletLinkErrorName["LINK_WALLET_ALREADY_LINKED"] = "LINK_WALLET_ALREADY_LINKED";
    WalletLinkErrorName["LINK_WALLET_LINKED_OTHER_ACCOUNT"] = "LINK_WALLET_LINKED_OTHER_ACCOUNT";
    WalletLinkErrorName["LINK_EMAIL_LINKED_OTHER_ACCOUNT"] = "LINK_EMAIL_LINKED_OTHER_ACCOUNT";
})(WalletLinkErrorName || (WalletLinkErrorName = {}));
/*** Phone Linking Errors ***/
var PhoneLinkErrorName;
(function (PhoneLinkErrorName) {
    PhoneLinkErrorName["LINK_PHONE_ALREADY_LINKED"] = "LINK_PHONE_ALREADY_LINKED";
    PhoneLinkErrorName["LINK_PHONE_LINKED_OTHER_ACCOUNT"] = "LINK_PHONE_LINKED_OTHER_ACCOUNT";
})(PhoneLinkErrorName || (PhoneLinkErrorName = {}));
/*** SMS Errors ***/
var SmsErrorName;
(function (SmsErrorName) {
    SmsErrorName["SMS_DELIVERY_FAILED"] = "SMS_DELIVERY_FAILED";
    SmsErrorName["SMS_VERIFICATION_FAILED"] = "SMS_VERIFICATION_FAILED";
})(SmsErrorName || (SmsErrorName = {}));
/*** Intent Errors ***/
var IntentErrorName;
(function (IntentErrorName) {
    IntentErrorName["INTENT_INVALID"] = "INTENT_INVALID";
    IntentErrorName["INTENT_LOCK_EXCEEDED"] = "INTENT_LOCK_EXCEEDED";
    IntentErrorName["INTENT_REQUIRED"] = "INTENT_REQUIRED";
    IntentErrorName["INTENT_UNSUPPORTED_TYPE"] = "INTENT_UNSUPPORTED_TYPE";
})(IntentErrorName || (IntentErrorName = {}));
/*** Privy Errors ***/
var PrivyErrorName;
(function (PrivyErrorName) {
    PrivyErrorName["WALLET_PROVIDER_ERROR"] = "WALLET_PROVIDER_ERROR";
})(PrivyErrorName || (PrivyErrorName = {}));
/*** Recovery Errors ***/
var RecoveryErrorName;
(function (RecoveryErrorName) {
    RecoveryErrorName["RECOVERY_NOT_CONFIGURED"] = "RECOVERY_NOT_CONFIGURED";
    RecoveryErrorName["RECOVERY_LOCK_EXCEEDED"] = "RECOVERY_LOCK_EXCEEDED";
})(RecoveryErrorName || (RecoveryErrorName = {}));
/*** Air ID Errors ***/
var AirIDErrorName;
(function (AirIDErrorName) {
    AirIDErrorName["AIR_ID_MINT_TRANSACTION_NOT_FOUND"] = "AIR_ID_MINT_TRANSACTION_NOT_FOUND";
    AirIDErrorName["AIR_ID_ON_CHAIN_TRANSACTION_NOT_FOUND"] = "AIR_ID_ON_CHAIN_TRANSACTION_NOT_FOUND";
    AirIDErrorName["AIR_ID_NOT_FOUND"] = "AIR_ID_NOT_FOUND";
    AirIDErrorName["AIR_ID_INVALID_OR_DISABLED_CONFIGURATION"] = "AIR_ID_INVALID_OR_DISABLED_CONFIGURATION";
    AirIDErrorName["AIR_ID_RPC_URL_NOT_CONFIGURED"] = "AIR_ID_RPC_URL_NOT_CONFIGURED";
    AirIDErrorName["AIR_ID_INVALID_STATUS"] = "AIR_ID_INVALID_STATUS";
    AirIDErrorName["AIR_ID_PARTNER_ELIGIBILITY_CHECK_FAILED"] = "AIR_ID_PARTNER_ELIGIBILITY_CHECK_FAILED";
    AirIDErrorName["AIR_ID_PARTNER_ELIGIBILITY_CHECK_TIMEOUT"] = "AIR_ID_PARTNER_ELIGIBILITY_CHECK_TIMEOUT";
    AirIDErrorName["AIR_ID_MULTIPLE_AIR_IDS_FOUND"] = "AIR_ID_MULTIPLE_AIR_IDS_FOUND";
    AirIDErrorName["AIR_ID_NAME_RESERVED"] = "AIR_ID_NAME_RESERVED";
    AirIDErrorName["AIR_ID_NAME_PROFANITY"] = "AIR_ID_NAME_PROFANITY";
    AirIDErrorName["AIR_ID_USER_ALREADY_HAS_AIR_ID"] = "AIR_ID_USER_ALREADY_HAS_AIR_ID";
    AirIDErrorName["AIR_ID_NAME_ALREADY_EXISTS"] = "AIR_ID_NAME_ALREADY_EXISTS";
    AirIDErrorName["AIR_ID_INVALID_MINT_NAME"] = "AIR_ID_INVALID_MINT_NAME";
    AirIDErrorName["AIR_ID_MINT_TRANSACTION_HASH_MISMATCH"] = "AIR_ID_MINT_TRANSACTION_HASH_MISMATCH";
})(AirIDErrorName || (AirIDErrorName = {}));
/*** Agent Errors ***/
var AgentErrorName;
(function (AgentErrorName) {
    AgentErrorName["CONFLICT_REQUEST"] = "CONFLICT_REQUEST";
    AgentErrorName["INVALID_PARAMETER"] = "INVALID_PARAMETER";
    AgentErrorName["WALLET_PROVIDER_ERROR"] = "WALLET_PROVIDER_ERROR";
})(AgentErrorName || (AgentErrorName = {}));
/*** Window Errors ***/
var WindowErrorName;
(function (WindowErrorName) {
    WindowErrorName["WINDOW_BLOCKED"] = "WINDOW_BLOCKED";
    WindowErrorName["WINDOW_CLOSED"] = "WINDOW_CLOSED";
})(WindowErrorName || (WindowErrorName = {}));
const Codes = {
    ...AuthErrorName,
    ...PartnerAccessTokenErrorName,
    ...RealmIDErrorName,
    ...ParameterErrorName,
    ...ServerErrorName,
    ...PasskeyErrorName,
    ...PasswordlessErrorName,
    ...AuthWalletErrorName,
    ...WalletLinkErrorName,
    ...PhoneLinkErrorName,
    ...SmsErrorName,
    ...IntentErrorName,
    ...PrivyErrorName,
    ...RecoveryErrorName,
    ...AirIDErrorName,
    ...WindowErrorName,
    ...AgentErrorName,
};

const AirClientUserErrors = [
    "USER_CANCELLED",
    "CONFIG_ERROR",
    "CLIENT_ERROR",
    "UNKNOWN_ERROR",
    "PERMISSION_NOT_ENABLED",
    "SMART_ACCOUNT_NOT_DEPLOYED",
    "ACCOUNT_DELETION_PENDING",
    "SWAP_TO_ONRAMP",
    "USER_REJECTED",
    "START_PIN_RECOVERY",
];

class AirError extends BaseError {
}
new Set(AirClientUserErrors);
new Set(Object.values(Codes));

class OutgoingMessageEvent extends MessageEvent {
}
class MessageServiceBase {
    get events$() {
        return this._events$;
    }
    get messages$() {
        return this._messages$;
    }
    get isOpen() {
        return this._isOpen$.value;
    }
    async waitUntilOpen() {
        if (this.isOpen)
            return;
        await firstValueFrom(this._isOpen$.pipe(filter(Boolean)));
    }
    constructor(name, allowedMessageTypes) {
        this.name = name;
        this.allowedMessageTypes = allowedMessageTypes;
        this.closeListener = null;
        this._isOpen$ = new BehaviorSubject(false);
        this.isOpen$ = this._isOpen$.asObservable();
    }
    static _getName(name, targetName) {
        return `${name} Service: ${targetName} Channel`;
    }
    async _open(target) {
        await this.close();
        this.eventSubject = new Subject();
        this._events$ = this.eventSubject.asObservable();
        this._messages$ = this.eventSubject.pipe(map((ev) => ev.data));
        this._events$.subscribe((event) => {
            const sentOrReceived = event instanceof OutgoingMessageEvent ? "sent" : "received";
            log.debug(`[${this.name}] Message ${sentOrReceived}:`, JSON.stringify(event.data, bigIntReplacer));
        });
        const handleMessage = async (ev) => {
            if ((this.targetOrigin && ev.origin !== this.targetOrigin) ||
                !ev.data ||
                !(ev.data instanceof Object))
                return;
            if (this.isMessageAllowed(ev.data)) {
                await this.onBeforeEvent(ev);
                this.eventSubject.next(ev);
            }
        };
        if (target instanceof MessagePort) {
            this.messagePort = target;
            target.onmessage = handleMessage;
            this.closeListener = async () => {
                this.messagePort?.close();
                this.messagePort = undefined;
            };
        }
        else if (target instanceof BroadcastChannel) {
            this.messageChannel = target;
            target.onmessage = handleMessage;
            this.closeListener = async () => {
                this.messageChannel?.close();
                this.messageChannel = undefined;
            };
        }
        else {
            this.targetWindow = target.window;
            this.targetOrigin = target.origin;
            window.addEventListener("message", handleMessage);
            this.closeListener = async () => {
                window.removeEventListener("message", handleMessage);
            };
        }
        this._isOpen$.next(true);
    }
    isMessageAllowed(message) {
        return this.allowedMessageTypes.includes(message.type);
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async onBeforeEvent(_event) {
        // by default not used
    }
    async close() {
        if (this.closeListener) {
            await this.closeListener();
            this.closeListener = null;
        }
        if (this.eventSubject && !this.eventSubject.closed) {
            this.eventSubject.complete();
        }
        if (this._isOpen$.value)
            this._isOpen$.next(false);
    }
    createErrorResponseMessage(type, error) {
        return {
            type,
            payload: {
                success: false,
                errorName: error instanceof AirError ? error.name : "UNKNOWN_ERROR",
                errorMessage: error.message,
            },
        };
    }
    async sendMessage(message, transfer) {
        // To prevent any non-cloneable objects causing errors in postMessage
        const clonedMessage = this.deepClone(message);
        if (this.messagePort) {
            this.messagePort.postMessage(clonedMessage);
        }
        else if (this.messageChannel) {
            this.messageChannel.postMessage(clonedMessage);
        }
        else if (this.targetWindow && this.targetOrigin) {
            this.targetWindow.postMessage(clonedMessage, this.targetOrigin, transfer);
        }
        else {
            log.debug(`[${this.name}] Not opened yet`);
            return;
        }
        this.eventSubject.next(new OutgoingMessageEvent("message", { data: clonedMessage, origin: window.origin }));
    }
    deepClone(message) {
        try {
            return JSON.parse(JSON.stringify(message, bigIntReplacer));
        }
        catch (e) {
            log.warn("Error generating cloneable message", e);
            return message;
        }
    }
}

var AirWalletProviderMessageTypes;
(function (AirWalletProviderMessageTypes) {
    AirWalletProviderMessageTypes["REQUEST"] = "JRPC_REQUEST";
    AirWalletProviderMessageTypes["RESPONSE"] = "JRPC_RESPONSE";
    AirWalletProviderMessageTypes["EVENT"] = "JRPC_EVENT";
})(AirWalletProviderMessageTypes || (AirWalletProviderMessageTypes = {}));

var _a$4, _ProviderMessageService_instance;
const ALLOWED_PROVIDER_MESSAGES = [
    AirWalletProviderMessageTypes.RESPONSE,
    AirWalletProviderMessageTypes.EVENT,
];
class ProviderMessageService extends MessageServiceBase {
    static create() {
        if (!__classPrivateFieldGet(this, _a$4, "f", _ProviderMessageService_instance)) {
            __classPrivateFieldSet(this, _a$4, new _a$4("Embed Service: Provider Channel", ALLOWED_PROVIDER_MESSAGES), "f", _ProviderMessageService_instance);
        }
        return __classPrivateFieldGet(this, _a$4, "f", _ProviderMessageService_instance);
    }
    async open(walletIframe) {
        const origin = new URL(walletIframe.src).origin;
        const contentWindow = walletIframe.contentWindow;
        if (!contentWindow) {
            throw new Error("Provider iframe has no content window");
        }
        await super._open({ window: contentWindow, origin });
    }
    async sendWalletProviderRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletProviderMessageTypes.RESPONSE), filter((msg) => msg.payload.method === payload.method && msg.payload.requestId === payload.requestId)));
        await this.sendMessage({
            type: AirWalletProviderMessageTypes.REQUEST,
            payload,
        });
        return response;
    }
}
_a$4 = ProviderMessageService;
_ProviderMessageService_instance = { value: void 0 };

var _AirWalletProvider_instances, _AirWalletProvider_providerMessageService, _AirWalletProvider_isWalletInitialized, _AirWalletProvider_getLoginResult, _AirWalletProvider_ensureWallet, _AirWalletProvider_eventListeners, _AirWalletProvider_currentChainId, _AirWalletProvider_getAddressForCurrentChain, _AirWalletProvider_parseChainId;
class AirWalletProvider {
    constructor({ ensureWallet, isWalletInitialized, getLoginResult, }) {
        _AirWalletProvider_instances.add(this);
        _AirWalletProvider_providerMessageService.set(this, void 0);
        _AirWalletProvider_isWalletInitialized.set(this, void 0);
        _AirWalletProvider_getLoginResult.set(this, void 0);
        _AirWalletProvider_ensureWallet.set(this, void 0);
        _AirWalletProvider_eventListeners.set(this, void 0);
        _AirWalletProvider_currentChainId.set(this, null);
        this.startEventMessageListening = async (walletIframe) => {
            await __classPrivateFieldGet(this, _AirWalletProvider_providerMessageService, "f").open(walletIframe);
            __classPrivateFieldGet(this, _AirWalletProvider_providerMessageService, "f").messages$
                .pipe(filter((msg) => msg.type === AirWalletProviderMessageTypes.EVENT))
                .subscribe((message) => {
                if (message.payload.event === "chainChanged") {
                    const parsedChainId = __classPrivateFieldGet(this, _AirWalletProvider_instances, "m", _AirWalletProvider_parseChainId).call(this, message.payload.data);
                    if (parsedChainId !== null) {
                        __classPrivateFieldSet(this, _AirWalletProvider_currentChainId, parsedChainId, "f");
                    }
                }
                const { event, data } = message.payload;
                (__classPrivateFieldGet(this, _AirWalletProvider_eventListeners, "f")[event] || []).forEach((listener) => {
                    try {
                        listener(data);
                    }
                    catch (error) {
                        log.warn(error);
                    }
                });
            });
        };
        __classPrivateFieldSet(this, _AirWalletProvider_providerMessageService, ProviderMessageService.create(), "f");
        __classPrivateFieldSet(this, _AirWalletProvider_ensureWallet, ensureWallet, "f");
        __classPrivateFieldSet(this, _AirWalletProvider_eventListeners, {
            connect: [],
            disconnect: [],
            accountsChanged: [],
            chainChanged: [],
            message: [],
        }, "f");
        __classPrivateFieldSet(this, _AirWalletProvider_isWalletInitialized, isWalletInitialized, "f");
        __classPrivateFieldSet(this, _AirWalletProvider_getLoginResult, getLoginResult, "f");
    }
    async request(request) {
        // Check if the request is valid
        if (!request || typeof request !== "object" || Array.isArray(request)) {
            throw new InvalidRequestRpcError("Invalid request");
        }
        const { method, params } = request;
        // Check if the method is valid
        if (typeof method !== "string" || method.length === 0) {
            throw new MethodNotFoundRpcError("Invalid method");
        }
        // Check if the params are valid
        if (params !== undefined &&
            !Array.isArray(params) &&
            (typeof params !== "object" || params === null)) {
            throw new InvalidParamsRpcError("Invalid params");
        }
        const loginResult = __classPrivateFieldGet(this, _AirWalletProvider_getLoginResult, "f").call(this);
        if (!loginResult) {
            throw new UnauthorizedProviderError("User is not logged in");
        }
        // Early return optimization: return cached address from login result if wallet not yet initialized
        if ((method === "eth_accounts" || method === "eth_requestAccounts") &&
            !__classPrivateFieldGet(this, _AirWalletProvider_isWalletInitialized, "f").call(this)) {
            const address = __classPrivateFieldGet(this, _AirWalletProvider_instances, "m", _AirWalletProvider_getAddressForCurrentChain).call(this, loginResult);
            if (address) {
                return [address];
            }
        }
        const skipWalletLoginMethods = ["eth_chainId"];
        try {
            if (skipWalletLoginMethods.includes(method)) {
                await __classPrivateFieldGet(this, _AirWalletProvider_ensureWallet, "f").call(this, { skipWalletLogin: true });
            }
            else {
                await __classPrivateFieldGet(this, _AirWalletProvider_ensureWallet, "f").call(this);
            }
        }
        catch (error) {
            throw ensureProviderRpcError(error);
        }
        const requestId = randomId();
        const response = await __classPrivateFieldGet(this, _AirWalletProvider_providerMessageService, "f").sendWalletProviderRequest({
            requestId,
            ...request,
        });
        if (!response.success) {
            throw ensureProviderRpcError(response.payload);
        }
        if (method === "eth_chainId") {
            const parsedChainId = __classPrivateFieldGet(this, _AirWalletProvider_instances, "m", _AirWalletProvider_parseChainId).call(this, response.payload.response);
            if (parsedChainId !== null) {
                __classPrivateFieldSet(this, _AirWalletProvider_currentChainId, parsedChainId, "f");
            }
        }
        return response.payload.response;
    }
    on(eventName, listener) {
        __classPrivateFieldGet(this, _AirWalletProvider_eventListeners, "f")[eventName] = __classPrivateFieldGet(this, _AirWalletProvider_eventListeners, "f")[eventName] || [];
        __classPrivateFieldGet(this, _AirWalletProvider_eventListeners, "f")[eventName].push(listener);
    }
    removeListener(eventName, listener) {
        __classPrivateFieldGet(this, _AirWalletProvider_eventListeners, "f")[eventName] = __classPrivateFieldGet(this, _AirWalletProvider_eventListeners, "f")[eventName] || [];
        const index = __classPrivateFieldGet(this, _AirWalletProvider_eventListeners, "f")[eventName].indexOf(listener);
        if (index >= 0) {
            __classPrivateFieldGet(this, _AirWalletProvider_eventListeners, "f")[eventName].splice(index, 1);
        }
    }
    removeAllListeners() {
        __classPrivateFieldSet(this, _AirWalletProvider_eventListeners, {
            connect: [],
            disconnect: [],
            accountsChanged: [],
            chainChanged: [],
            message: [],
        }, "f");
    }
}
_AirWalletProvider_providerMessageService = new WeakMap(), _AirWalletProvider_isWalletInitialized = new WeakMap(), _AirWalletProvider_getLoginResult = new WeakMap(), _AirWalletProvider_ensureWallet = new WeakMap(), _AirWalletProvider_eventListeners = new WeakMap(), _AirWalletProvider_currentChainId = new WeakMap(), _AirWalletProvider_instances = new WeakSet(), _AirWalletProvider_getAddressForCurrentChain = function _AirWalletProvider_getAddressForCurrentChain(loginResult) {
    const currentChainId = __classPrivateFieldGet(this, _AirWalletProvider_currentChainId, "f");
    // If we have the new addresses array and current chainId, look up by chain
    if (loginResult.abstractAccountAddresses && currentChainId !== null) {
        const chainIdStr = String(currentChainId);
        const addressEntry = loginResult.abstractAccountAddresses.find((entry) => entry.chainIds.includes(chainIdStr));
        if (addressEntry) {
            return addressEntry.address;
        }
    }
    // Fallback to legacy single address (backward compatibility)
    return loginResult.abstractAccountAddress;
}, _AirWalletProvider_parseChainId = function _AirWalletProvider_parseChainId(chainId) {
    if (typeof chainId === "number") {
        return Number.isFinite(chainId) ? chainId : null;
    }
    if (typeof chainId === "bigint") {
        return Number(chainId);
    }
    if (typeof chainId !== "string" || !chainId) {
        return null;
    }
    const parsed = chainId.startsWith("0x")
        ? parseInt(chainId, 16)
        : parseInt(chainId, 10);
    return Number.isNaN(parsed) ? null : parsed;
};

var _a$3, _AuthMessageService_instance;
const ALLOWED_AUTH_MESSAGES = [
    AirAuthMessageTypes.INITIALIZATION_RESPONSE,
    AirAuthMessageTypes.LOGIN_RESPONSE,
    AirAuthMessageTypes.SETUP_WALLET_REQUEST,
    AirAuthMessageTypes.SETUP_RECOVERY_REQUEST,
    AirAuthMessageTypes.SETUP_CREDENTIAL_REQUEST,
    AirAuthMessageTypes.LOGOUT_RESPONSE,
    AirAuthMessageTypes.UPDATE_SESSION_CONFIG_RESPONSE,
    AirAuthMessageTypes.PARTNER_USER_INFO_RESPONSE,
    AirAuthMessageTypes.CROSS_PARTNER_TOKEN_RESPONSE,
    AirAuthMessageTypes.PARTNER_ACCESS_TOKEN_RESPONSE,
    AirAuthMessageTypes.IFRAME_VISIBILITY_REQUEST,
    AirAuthMessageTypes.START_RECOVERY_RESPONSE,
    AirAuthMessageTypes.EXPIRED_LOGOUT_REQUEST,
];
class AuthMessageService extends MessageServiceBase {
    static create() {
        if (!__classPrivateFieldGet(this, _a$3, "f", _AuthMessageService_instance)) {
            __classPrivateFieldSet(this, _a$3, new _a$3("Embed Service: Auth Channel", ALLOWED_AUTH_MESSAGES), "f", _AuthMessageService_instance);
        }
        return __classPrivateFieldGet(this, _a$3, "f", _AuthMessageService_instance);
    }
    async open(authIframe) {
        const origin = new URL(authIframe.src).origin;
        const contentWindow = authIframe.contentWindow;
        if (!contentWindow) {
            throw new Error("Auth iframe has no content window");
        }
        await super._open({ window: contentWindow, origin });
    }
    async sendPartnerUserInfoRequest() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirAuthMessageTypes.PARTNER_USER_INFO_RESPONSE)));
        await this.sendMessage({
            type: AirAuthMessageTypes.PARTNER_USER_INFO_REQUEST,
            payload: { allowCache: false },
        });
        return response;
    }
    async sendUpdateSessionConfigRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirAuthMessageTypes.UPDATE_SESSION_CONFIG_RESPONSE)));
        await this.sendMessage({
            type: AirAuthMessageTypes.UPDATE_SESSION_CONFIG_REQUEST,
            payload: payload ?? {},
        });
        return response;
    }
    async sendLoginRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirAuthMessageTypes.LOGIN_RESPONSE)));
        await this.sendMessage({
            type: AirAuthMessageTypes.LOGIN_REQUEST,
            payload: payload ?? {},
        });
        return response;
    }
    onLoggedIn() {
        return firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirAuthMessageTypes.LOGIN_RESPONSE && msg.payload?.success === true)));
    }
    async logout() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirAuthMessageTypes.LOGOUT_RESPONSE)));
        await this.sendMessage({ type: AirAuthMessageTypes.LOGOUT_REQUEST });
        return response;
    }
    async sendInitializationRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirAuthMessageTypes.INITIALIZATION_RESPONSE)));
        await this.sendMessage({ type: AirAuthMessageTypes.INITIALIZATION_REQUEST, payload });
        return response;
    }
    async sendSetupWalletSuccessResponse() {
        await this.sendMessage({
            type: AirAuthMessageTypes.SETUP_WALLET_RESPONSE,
            payload: {
                success: true,
            },
        });
    }
    async sendSetupWalletErrorResponse(error) {
        await this.sendMessage(this.createErrorResponseMessage(AirAuthMessageTypes.SETUP_WALLET_RESPONSE, error));
    }
    async sendSetupRecoverySuccessResponse() {
        await this.sendMessage({
            type: AirAuthMessageTypes.SETUP_RECOVERY_RESPONSE,
            payload: { success: true },
        });
    }
    async sendSetupRecoveryErrorResponse(error) {
        await this.sendMessage({
            type: AirAuthMessageTypes.SETUP_RECOVERY_RESPONSE,
            payload: {
                success: false,
                errorName: error instanceof AirError ? error.name : "UNKNOWN_ERROR",
                errorMessage: error.message,
            },
        });
    }
    async sendSetupCredentialSuccessResponse() {
        await this.sendMessage({
            type: AirAuthMessageTypes.SETUP_CREDENTIAL_RESPONSE,
            payload: { success: true },
        });
    }
    async sendSetupCredentialErrorResponse(error) {
        await this.sendMessage(this.createErrorResponseMessage(AirAuthMessageTypes.SETUP_CREDENTIAL_RESPONSE, error));
    }
    async sendCrossPartnerTokenRequest(targetPartnerUrl) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirAuthMessageTypes.CROSS_PARTNER_TOKEN_RESPONSE)));
        await this.sendMessage({
            type: AirAuthMessageTypes.CROSS_PARTNER_TOKEN_REQUEST,
            payload: {
                targetPartnerUrl,
            },
        });
        return response;
    }
    async sendPartnerAccessTokenRequest() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirAuthMessageTypes.PARTNER_ACCESS_TOKEN_RESPONSE)));
        await this.sendMessage({ type: AirAuthMessageTypes.PARTNER_ACCESS_TOKEN_REQUEST });
        return response;
    }
    async sendAccountRecoveryRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirAuthMessageTypes.START_RECOVERY_RESPONSE)));
        await this.sendMessage({
            type: AirAuthMessageTypes.START_RECOVERY_REQUEST,
            payload: payload ?? {},
        });
        return response;
    }
}
_a$3 = AuthMessageService;
_AuthMessageService_instance = { value: void 0 };

var _a$2, _CredentialMessageService_instance;
const ALLOWED_CREDENTIAL_MESSAGES = [
    AirCredentialMessageTypes.INITIALIZATION_RESPONSE,
    AirCredentialMessageTypes.CREDENTIAL_IFRAME_VISIBILITY_REQUEST,
    AirCredentialMessageTypes.UPDATE_SESSION_CONFIG_RESPONSE,
    AirCredentialMessageTypes.LOGOUT_RESPONSE,
    AirCredentialMessageTypes.ISSUE_CREDENTIAL_RESPONSE,
    AirCredentialMessageTypes.VERIFY_CREDENTIAL_RESPONSE,
];
class CredentialMessageService extends MessageServiceBase {
    static create() {
        if (!__classPrivateFieldGet(this, _a$2, "f", _CredentialMessageService_instance)) {
            __classPrivateFieldSet(this, _a$2, new _a$2("Embed Service: Credential Channel", ALLOWED_CREDENTIAL_MESSAGES), "f", _CredentialMessageService_instance);
        }
        return __classPrivateFieldGet(this, _a$2, "f", _CredentialMessageService_instance);
    }
    async open(iframeElement) {
        const contentWindow = iframeElement.contentWindow;
        if (!contentWindow) {
            throw new Error("Credential iframe has no content window");
        }
        await this._open({
            window: contentWindow,
            origin: new URL(iframeElement.src).origin,
        });
    }
    async sendInitializationRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirCredentialMessageTypes.INITIALIZATION_RESPONSE)));
        await this.sendMessage({
            type: AirCredentialMessageTypes.INITIALIZATION_REQUEST,
            payload,
        });
        return response;
    }
    async sendUpdateSessionConfigRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirCredentialMessageTypes.UPDATE_SESSION_CONFIG_RESPONSE)));
        await this.sendMessage({
            type: AirCredentialMessageTypes.UPDATE_SESSION_CONFIG_REQUEST,
            payload: payload ?? {},
        });
        return response;
    }
    async logout() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirCredentialMessageTypes.LOGOUT_RESPONSE)));
        await this.sendMessage({
            type: AirCredentialMessageTypes.LOGOUT_REQUEST,
        });
        return response;
    }
    async sendIssueCredentialRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirCredentialMessageTypes.ISSUE_CREDENTIAL_RESPONSE)));
        await this.sendMessage({
            type: AirCredentialMessageTypes.ISSUE_CREDENTIAL_REQUEST,
            payload,
        });
        return response;
    }
    async sendVerifyCredentialRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirCredentialMessageTypes.VERIFY_CREDENTIAL_RESPONSE)));
        await this.sendMessage({
            type: AirCredentialMessageTypes.VERIFY_CREDENTIAL_REQUEST,
            payload,
        });
        return response;
    }
    async close() {
        await super.close();
    }
}
_a$2 = CredentialMessageService;
_CredentialMessageService_instance = { value: void 0 };

class IframeController {
    getZIndex() {
        for (let i = 0; i < IFRAME_NAME_PREFIX_SET.length; i++) {
            const prefix = IFRAME_NAME_PREFIX_SET[i];
            if (this.iframeId.includes(prefix)) {
                return IframeController.HIGHEST_Z_INDEX - i;
            }
        }
        return IframeController.HIGHEST_Z_INDEX - IFRAME_NAME_PREFIX_SET.length; // Lowest z-index if no match
    }
    constructor(iframePrefix, iframeUrl, state) {
        this._iframeElement = null;
        this.state = {
            ...IframeController.DEFAULT_STATE,
            ...state,
        };
        this.iframeUrl = iframeUrl;
        this.iframeId = `${iframePrefix}-${randomId()}`;
    }
    get iframeElement() {
        return this._iframeElement;
    }
    get isVisible() {
        return this.state.isVisible;
    }
    createIframe() {
        if (this._iframeElement)
            return this._iframeElement;
        const iframe = document.createElement("iframe");
        iframe.id = this.iframeId;
        iframe.allow = [
            "publickey-credentials-get *",
            "publickey-credentials-create *",
            "ch-ua-model",
            "ch-ua-platform-version",
            "clipboard-read",
            "clipboard-write",
            "web-share",
        ].join("; ");
        iframe.src = this.iframeUrl;
        iframe.style.position = "fixed";
        iframe.style.zIndex = `${this.getZIndex()}`;
        iframe.style.border = "none";
        iframe.style.margin = "0";
        iframe.style.padding = "0";
        iframe.style.display = "none";
        iframe.style.colorScheme = "auto";
        iframe.setAttribute("sandbox", [
            "allow-scripts",
            "allow-same-origin",
            "allow-storage-access-by-user-activation",
            "allow-modals",
            "allow-popups",
            "allow-popups-to-escape-sandbox", // for google login
            "allow-forms", // for google login
            "allow-downloads", // for recovery export
            "allow-top-navigation-by-user-activation",
        ].join(" "));
        document.body.appendChild(iframe);
        this._iframeElement = iframe;
        return iframe;
    }
    setIframeVisibility(isVisible) {
        this.state.isVisible = isVisible;
    }
    updateIframeState() {
        if (!this.iframeElement)
            return;
        const style = {};
        style.display = this.state.isVisible ? "block" : "none";
        style.width = "100%";
        style.height = "100%";
        style.top = "0px";
        style.right = "0px";
        style.left = "0px";
        style.bottom = "0px";
        Object.assign(this.iframeElement.style, style);
    }
    focus() {
        try {
            this.iframeElement?.focus();
        }
        catch {
            // Some browsers reject cross-origin focus() outside a user gesture.
            // The first interaction inside the iframe will restore the correct
            // keyboard routing, so swallowing this is safe.
        }
    }
    destroy() {
        if (this.iframeElement) {
            this.iframeElement.remove();
            this._iframeElement = null;
        }
    }
    postMessage(message) {
        if (!this.iframeElement)
            return;
        const { origin } = new URL(this.iframeElement.src);
        const target = this.iframeElement.contentWindow;
        if (!target)
            return;
        target.postMessage(message, origin);
    }
}
IframeController.DEFAULT_STATE = {
    isVisible: false,
};
IframeController.HIGHEST_Z_INDEX = 2147483647;

var _a$1, _RecoveryMessageService_instance;
const ALLOWED_RECOVERY_MESSAGES = Object.values(AirRecoveryMessageTypes);
class RecoveryMessageService extends MessageServiceBase {
    static create() {
        if (!__classPrivateFieldGet(this, _a$1, "f", _RecoveryMessageService_instance)) {
            __classPrivateFieldSet(this, _a$1, new _a$1("Recovery Service", ALLOWED_RECOVERY_MESSAGES), "f", _RecoveryMessageService_instance);
        }
        return __classPrivateFieldGet(this, _a$1, "f", _RecoveryMessageService_instance);
    }
    async sendInitializationRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirRecoveryMessageTypes.INITIALIZATION_RESPONSE)));
        await this.sendMessage({
            type: AirRecoveryMessageTypes.INITIALIZATION_REQUEST,
            payload,
        });
        return response;
    }
    async onInitialized() {
        return firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirRecoveryMessageTypes.RECOVERY_INITIALIZED)));
    }
    async sendUpdateSessionConfigRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirRecoveryMessageTypes.UPDATE_SESSION_CONFIG_RESPONSE)));
        await this.sendMessage({
            type: AirRecoveryMessageTypes.UPDATE_SESSION_CONFIG_REQUEST,
            payload: payload ?? {},
        });
        return response;
    }
    async logout() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirRecoveryMessageTypes.LOGOUT_RESPONSE)));
        await this.sendMessage({ type: AirRecoveryMessageTypes.LOGOUT_REQUEST });
        return response;
    }
    async sendGetAgentKeysRequest() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirRecoveryMessageTypes.GET_AGENT_KEYS_RESPONSE)));
        await this.sendMessage({
            type: AirRecoveryMessageTypes.GET_AGENT_KEYS_REQUEST,
        });
        return response;
    }
    async sendRegisterAgentKeyRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirRecoveryMessageTypes.REGISTER_AGENT_KEY_RESPONSE)));
        await this.sendMessage({
            type: AirRecoveryMessageTypes.REGISTER_AGENT_KEY_REQUEST,
            payload,
        });
        return response;
    }
    async sendRemoveAgentKeyRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirRecoveryMessageTypes.REMOVE_AGENT_KEY_RESPONSE)));
        await this.sendMessage({
            type: AirRecoveryMessageTypes.REMOVE_AGENT_KEY_REQUEST,
            payload,
        });
        return response;
    }
    async open(element) {
        const contentWindow = element.contentWindow;
        if (!contentWindow) {
            throw new Error("Recovery iframe has no content window");
        }
        await this._open({ window: contentWindow, origin: new URL(element.src).origin });
    }
    async close() {
        await super.close();
    }
}
_a$1 = RecoveryMessageService;
_RecoveryMessageService_instance = { value: void 0 };

var _a, _WalletMessageService_instance;
const ALLOWED_WALLET_MESSAGES = [
    AirWalletMessageTypes.INITIALIZATION_RESPONSE,
    AirWalletMessageTypes.WALLET_INITIALIZED,
    AirWalletMessageTypes.UPDATE_SESSION_CONFIG_RESPONSE,
    AirWalletMessageTypes.WALLET_LOGIN_RESPONSE,
    AirWalletMessageTypes.SETUP_OR_UPDATE_MFA_RESPONSE,
    AirWalletMessageTypes.SHOW_SWAP_UI_RESPONSE,
    AirWalletMessageTypes.SHOW_ON_RAMP_UI_RESPONSE,
    AirWalletMessageTypes.SHOW_TRANSFER_UI_RESPONSE,
    AirWalletMessageTypes.SHOW_RECEIVE_UI_RESPONSE,
    AirWalletMessageTypes.CLAIM_ID_RESPONSE,
    AirWalletMessageTypes.IS_SMART_ACCOUNT_DEPLOYED_RESPONSE,
    AirWalletMessageTypes.DEPLOY_SMART_ACCOUNT_RESPONSE,
    AirWalletMessageTypes.WALLET_IFRAME_VISIBILITY_REQUEST,
    AirWalletMessageTypes.LOGOUT_RESPONSE,
    AirWindowMessageTypes.OPEN_WINDOW_REQUEST,
    AirWindowMessageTypes.OPEN_WINDOW_RETRY_RESPONSE,
];
class WalletMessageService extends MessageServiceBase {
    static create() {
        if (!__classPrivateFieldGet(this, _a, "f", _WalletMessageService_instance)) {
            __classPrivateFieldSet(this, _a, new _a("Embed Service: Wallet Channel", ALLOWED_WALLET_MESSAGES), "f", _WalletMessageService_instance);
        }
        return __classPrivateFieldGet(this, _a, "f", _WalletMessageService_instance);
    }
    async open(walletIframe) {
        const origin = new URL(walletIframe.src).origin;
        const contentWindow = walletIframe.contentWindow;
        if (!contentWindow) {
            throw new Error("Wallet iframe has no content window");
        }
        await super._open({ window: contentWindow, origin });
    }
    async sendDeploySmartAccountRequest() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.DEPLOY_SMART_ACCOUNT_RESPONSE)));
        await this.sendMessage({
            type: AirWalletMessageTypes.DEPLOY_SMART_ACCOUNT_REQUEST,
        });
        return response;
    }
    async sendIsSmartAccountDeployedRequest() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.IS_SMART_ACCOUNT_DEPLOYED_RESPONSE)));
        await this.sendMessage({
            type: AirWalletMessageTypes.IS_SMART_ACCOUNT_DEPLOYED_REQUEST,
        });
        return response;
    }
    async logout() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.LOGOUT_RESPONSE)));
        await this.sendMessage({ type: AirWalletMessageTypes.LOGOUT_REQUEST });
        return response;
    }
    async sendInitializationRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.INITIALIZATION_RESPONSE)));
        await this.sendMessage({ type: AirWalletMessageTypes.INITIALIZATION_REQUEST, payload });
        return response;
    }
    onInitialized() {
        return firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.WALLET_INITIALIZED)));
    }
    async sendUpdateSessionConfigRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.UPDATE_SESSION_CONFIG_RESPONSE)));
        await this.sendMessage({
            type: AirWalletMessageTypes.UPDATE_SESSION_CONFIG_REQUEST,
            payload: payload ?? {},
        });
        return response;
    }
    async sendLoginRequest() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.WALLET_LOGIN_RESPONSE)));
        await this.sendMessage({
            type: AirWalletMessageTypes.WALLET_LOGIN_REQUEST,
        });
        return response;
    }
    async sendSetupMfaRequest() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.SETUP_OR_UPDATE_MFA_RESPONSE)));
        await this.sendMessage({
            type: AirWalletMessageTypes.SETUP_OR_UPDATE_MFA_REQUEST,
        });
        return response;
    }
    async sendOpenWindowSuccessResponse(windowId, port) {
        await this.sendMessage({
            type: AirWindowMessageTypes.OPEN_WINDOW_RESPONSE,
            payload: {
                success: true,
                windowId,
            },
        }, [port]);
    }
    async sendOpenWindowErrorResponse(windowId, error) {
        const errorResponse = this.createErrorResponseMessage(AirWindowMessageTypes.OPEN_WINDOW_RESPONSE, error);
        await this.sendMessage({
            ...errorResponse,
            payload: { ...errorResponse.payload, windowId },
        });
    }
    async sendOpenWindowRetryRequest(windowId) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWindowMessageTypes.OPEN_WINDOW_RETRY_RESPONSE), filter((msg) => msg.payload.windowId === windowId)));
        await this.sendMessage({
            type: AirWindowMessageTypes.OPEN_WINDOW_RETRY_REQUEST,
            payload: { windowId },
        });
        return response;
    }
    async sendWindowClosed(windowId) {
        await this.sendMessage({
            type: AirWindowMessageTypes.WINDOW_CLOSED,
            payload: {
                windowId,
            },
        });
    }
    async sendClaimIdRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.CLAIM_ID_RESPONSE)));
        await this.sendMessage({ type: AirWalletMessageTypes.CLAIM_ID_REQUEST, payload });
        return response;
    }
    async sendShowSwapUIRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.SHOW_SWAP_UI_RESPONSE)));
        await this.sendMessage({
            type: AirWalletMessageTypes.SHOW_SWAP_UI_REQUEST,
            payload: {
                initialFromToken: payload?.initialFromToken,
                fallbackFromToken: payload?.fallbackFromToken,
                initialToToken: payload?.initialToToken,
                defaultSlippage: payload?.defaultSlippage?.toString(), // TODO refactor to all be numbers 
            },
        });
        return response;
    }
    async sendShowOnRampUIRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.SHOW_ON_RAMP_UI_RESPONSE)));
        await this.sendMessage({
            type: AirWalletMessageTypes.SHOW_ON_RAMP_UI_REQUEST,
            payload,
        });
        return response;
    }
    async sendShowTransferUIRequest(payload) {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.SHOW_TRANSFER_UI_RESPONSE)));
        await this.sendMessage({
            type: AirWalletMessageTypes.SHOW_TRANSFER_UI_REQUEST,
            payload: {
                tokenSymbol: payload?.tokenSymbol,
                chainId: payload?.chainId,
                recipientAddress: payload?.recipientAddress,
                amount: payload?.amount,
            },
        });
        return response;
    }
    async sendShowReceiveUIRequest() {
        const response = firstValueFrom(this.messages$.pipe(filter((msg) => msg.type === AirWalletMessageTypes.SHOW_RECEIVE_UI_RESPONSE)));
        await this.sendMessage({
            type: AirWalletMessageTypes.SHOW_RECEIVE_UI_REQUEST,
        });
        return response;
    }
}
_a = WalletMessageService;
_WalletMessageService_instance = { value: void 0 };

class WindowController {
    get messages$() {
        return this._messages$.asObservable();
    }
    constructor(windowId, windowUrl) {
        this._windowInstance = null;
        this._messageHandler = null;
        this._messages$ = new Subject();
        this.windowId = windowId;
        this.windowUrl = windowUrl;
        this.windowOrigin = new URL(windowUrl).origin;
        this._messageHandler = (ev) => {
            if (!ev.data || !(ev.data instanceof Object) || !this.isFromManagedWindow(ev)) {
                return;
            }
            this._messages$.next(ev);
        };
        window.addEventListener("message", this._messageHandler);
    }
    get windowInstance() {
        return this._windowInstance;
    }
    async openWindow(onRetry) {
        let windowInstance = this.tryOpenWindow();
        if (!windowInstance) {
            await onRetry();
            windowInstance = this.tryOpenWindow();
            if (!windowInstance) {
                throw new AirError(WindowErrorName.WINDOW_BLOCKED);
            }
        }
        const pendingWindowOpenCheck = new Promise((resolve, reject) => {
            setTimeout(() => {
                // Check the live reference: a handshake message under slow automation can
                // rebind it to the real window, while the proxy captured at open time may
                // read stale/closed and trigger a spurious reopen mid-handshake.
                if (this.isWindowOpen(this._windowInstance)) {
                    // only now are we scheduling the close event check since we're sure the window is open
                    this.scheduleWindowClosedChecks();
                    resolve("opened");
                }
                else {
                    onRetry()
                        .then(() => {
                        const reopened = this.tryOpenWindow();
                        if (reopened) {
                            this._windowInstance = reopened;
                            reopened.focus();
                            this.scheduleWindowClosedChecks();
                            resolve("retry");
                        }
                        else {
                            reject(new AirError(WindowErrorName.WINDOW_BLOCKED));
                        }
                    })
                        .catch(reject);
                }
            }, 1000);
        });
        this._windowInstance = windowInstance;
        windowInstance.focus();
        return { pendingWindowOpenCheck };
    }
    postMessage(message, transfer) {
        if (!this._windowInstance)
            return;
        this._windowInstance.postMessage(message, this.windowOrigin, transfer);
    }
    onMessage(callback) {
        const listener = (ev) => {
            if (!this.isFromManagedWindow(ev))
                return;
            callback(ev);
        };
        window.addEventListener("message", listener);
        const close = () => window.removeEventListener("message", listener);
        this.onClose(close);
        return {
            close,
        };
    }
    cleanup() {
        if (this._windowInstance && !this._windowInstance.closed) {
            this._windowInstance.close();
        }
        this._windowInstance = null;
        if (this._messageHandler) {
            window.removeEventListener("message", this._messageHandler);
            this._messageHandler = null;
        }
        if (this._messages$ && !this._messages$.closed) {
            this._messages$.complete();
        }
    }
    onClose(callback) {
        return this._messages$.subscribe({
            complete: callback,
        });
    }
    // Accept by origin + the windowId echoed in the message data (the unguessable
    // name we assigned), rather than WindowProxy identity. ev.source identity
    // churns under slow loads / automation reopen and its `.name` is often
    // unreadable across processes, so the bootstrap handshake echoes the windowId.
    // Messages without a windowId fall back to source identity.
    isFromManagedWindow(ev) {
        if (ev.origin !== this.windowOrigin || !ev.source)
            return false;
        const data = ev.data;
        const windowIdMatches = !!data && typeof data === "object" && data.windowId === this.windowId;
        if (!windowIdMatches && ev.source !== this._windowInstance)
            return false;
        // Re-bind to the verified live source so postMessage targets it; the proxy
        // captured at open time can go stale under automation.
        if (windowIdMatches && ev.source !== this._windowInstance) {
            this._windowInstance = ev.source;
        }
        return true;
    }
    isWindowOpen(windowInstance) {
        // Only an explicitly-closed/missing window is not-open: a still-loading
        // popup can report `closed === undefined` under automation, and treating
        // that as closed triggers a reopen that breaks the handshake.
        return !!windowInstance && windowInstance.closed !== true;
    }
    tryOpenWindow() {
        const windowInstance = window.open(this.windowUrl, this.windowId, getWindowFeatures(425, 680));
        if (this.isWindowOpen(windowInstance)) {
            return windowInstance;
        }
        return null;
    }
    scheduleWindowClosedChecks() {
        let closedStrikes = 0;
        const checkWindow = setInterval(() => {
            const instance = this._windowInstance;
            // Two consecutive closed reads: a slow-loading popup can briefly report
            // closed before its document commits under automation.
            if (!instance || instance.closed) {
                if (++closedStrikes < 2)
                    return;
                clearInterval(checkWindow);
                this.cleanup();
            }
            else {
                closedStrikes = 0;
            }
        }, 500);
    }
}

let WindowService$1 = class WindowService {
    constructor() {
        this.windowControllers = new Map();
    }
    static get instance() {
        return this._instance || (this._instance = new this());
    }
    async sendWindowInitializationRequest(windowId, payload, port) {
        const windowController = this.windowControllers.get(windowId);
        if (!windowController) {
            throw new Error("Window controller not found");
        }
        const windowInstance = windowController.windowInstance;
        if (!windowInstance) {
            throw new Error("Window instance not found");
        }
        const response = firstValueFrom(windowController.messages$.pipe(filter((event) => event.data.type ===
            AirWalletMessageTypes.INITIALIZATION_RESPONSE)));
        windowController.postMessage({ type: AirWalletMessageTypes.INITIALIZATION_REQUEST, payload }, [
            port,
        ]);
        return (await response).data;
    }
    async openAndInitializeWalletServiceWindow({ url, windowId, sessionId, partnerId, enableLogging, onRetry, sdkVersion, enableAutomation, }) {
        if (this.windowControllers.has(windowId)) {
            throw new Error("Window controller already exists");
        }
        const windowController = new WindowController(windowId, url);
        const { pendingWindowOpenCheck } = await windowController.openWindow(onRetry);
        windowController.onClose(() => {
            this.removeWindowController(windowId);
        });
        this.windowControllers.set(windowId, windowController);
        let channel = null;
        const initializeWindow = () => {
            return new Promise((resolve, reject) => {
                windowController.onMessage(async (ev) => {
                    if (isAirServiceStartedMessage(ev.data)) {
                        try {
                            channel = new MessageChannel();
                            const { payload } = await this.sendWindowInitializationRequest(windowId, {
                                sessionId,
                                partnerId,
                                enableLogging,
                                sdkVersion,
                                enableAutomation,
                            }, channel.port1);
                            if (payload.success === false) {
                                reject(new AirServiceError(payload.errorName, payload.errorMessage));
                            }
                            else {
                                resolve();
                            }
                        }
                        catch (e) {
                            reject(e);
                        }
                    }
                });
            });
        };
        const initializeWindowPromise = initializeWindow();
        const result = await pendingWindowOpenCheck;
        if (result === "retry") {
            // we can ignore previous initialization attempt since a new window was opened
            await initializeWindow();
        }
        else {
            await initializeWindowPromise;
        }
        return { windowController, port: channel.port2 };
    }
    getWindowController(windowId) {
        return this.windowControllers.get(windowId);
    }
    removeWindowController(windowId) {
        this.windowControllers.delete(windowId);
    }
};
var WindowService = WindowService$1.instance;

var _AirService_instances, _AirService_loginResult, _AirService_buildEnv, _AirService_enableLogging, _AirService_partnerId, _AirService_sessionId, _AirService_sessionConfig, _AirService_authMessagingService, _AirService_authIframeController, _AirService_isAuthInitialized, _AirService_airEventListener, _AirService_walletMessagingService, _AirService_walletIframeController, _AirService_walletInitialization, _AirService_walletLoggedInResult, _AirService_airWalletProvider, _AirService_recoveryInitialization, _AirService_recoveryMessagingService, _AirService_recoveryIframeController, _AirService_credentialsInitialization, _AirService_credentialMessagingService, _AirService_credentialIframeController, _AirService_credentialNetwork, _AirService_stripGoogleRedirectParamsFromUrl, _AirService_assertInitialized, _AirService_assertLoggedIn, _AirService_getBuildEnv, _AirService_ensureCredential, _AirService_initializeCredentials, _AirService_subscribeToCredentialEvents, _AirService_cleanUpCredential, _AirService_ensureWallet, _AirService_initializeWallet, _AirService_subscribeToWalletEvents, _AirService_triggerEventListeners, _AirService_triggerAirAuthInitialized, _AirService_triggerAirAuthLoggedIn, _AirService_triggerAirAuthLoggedOut, _AirService_triggerWalletInitialized, _AirService_assignAndTriggerLoginResult, _AirService_createWalletInitializedResult, _AirService_cleanUpAuth, _AirService_cleanUpWallet, _AirService_ensureRecovery, _AirService_initializeRecovery, _AirService_subscribeToRecoveryEvents, _AirService_cleanUpRecovery, _AirService_refocusTopmostVisibleIframe;
const airKitVersion = airkitPackage.version;
class AirService {
    constructor({ partnerId }) {
        _AirService_instances.add(this);
        _AirService_loginResult.set(this, void 0);
        _AirService_buildEnv.set(this, void 0);
        _AirService_enableLogging.set(this, false);
        _AirService_partnerId.set(this, void 0);
        _AirService_sessionId.set(this, void 0);
        _AirService_sessionConfig.set(this, void 0);
        //#modalZIndex: number; TODO implement z index overwrite
        _AirService_authMessagingService.set(this, void 0);
        _AirService_authIframeController.set(this, void 0);
        _AirService_isAuthInitialized.set(this, false);
        _AirService_airEventListener.set(this, []);
        _AirService_walletMessagingService.set(this, void 0);
        _AirService_walletIframeController.set(this, void 0);
        _AirService_walletInitialization.set(this, void 0);
        _AirService_walletLoggedInResult.set(this, void 0);
        _AirService_airWalletProvider.set(this, void 0);
        _AirService_recoveryInitialization.set(this, void 0);
        _AirService_recoveryMessagingService.set(this, void 0);
        _AirService_recoveryIframeController.set(this, void 0);
        _AirService_credentialsInitialization.set(this, void 0);
        _AirService_credentialMessagingService.set(this, void 0);
        _AirService_credentialIframeController.set(this, void 0);
        _AirService_credentialNetwork.set(this, void 0);
        __classPrivateFieldSet(this, _AirService_partnerId, partnerId, "f");
        __classPrivateFieldSet(this, _AirService_authMessagingService, AuthMessageService.create(), "f");
        __classPrivateFieldSet(this, _AirService_walletMessagingService, WalletMessageService.create(), "f");
        __classPrivateFieldSet(this, _AirService_recoveryMessagingService, RecoveryMessageService.create(), "f");
        __classPrivateFieldSet(this, _AirService_credentialMessagingService, CredentialMessageService.create(), "f");
        __classPrivateFieldSet(this, _AirService_airWalletProvider, new AirWalletProvider({
            isWalletInitialized: () => this.isWalletInitialized,
            ensureWallet: __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).bind(this),
            getLoginResult: () => __classPrivateFieldGet(this, _AirService_loginResult, "f"),
        }), "f");
        FONT_CDNS.forEach((cdn) => addResourceHints(cdn, { prefetch: false }));
    }
    get buildEnv() {
        return __classPrivateFieldGet(this, _AirService_buildEnv, "f");
    }
    get isInitialized() {
        return __classPrivateFieldGet(this, _AirService_isAuthInitialized, "f");
    }
    get isLoggedIn() {
        return !!__classPrivateFieldGet(this, _AirService_loginResult, "f");
    }
    get loginResult() {
        return __classPrivateFieldGet(this, _AirService_loginResult, "f");
    }
    get isWalletInitialized() {
        return !!__classPrivateFieldGet(this, _AirService_walletLoggedInResult, "f");
    }
    get provider() {
        const provider = __classPrivateFieldGet(this, _AirService_airWalletProvider, "f");
        return {
            request: provider.request.bind(provider),
            on: provider.on.bind(provider),
            removeListener: provider.removeListener.bind(provider),
        };
    }
    shouldEnableAutomation() {
        return localStorage.getItem("automation") === "true" && __classPrivateFieldGet(this, _AirService_buildEnv, "f") !== BUILD_ENV.PRODUCTION;
    }
    async init(config) {
        const { buildEnv = BUILD_ENV.PRODUCTION, enableLogging = false, skipRehydration = false, sessionConfig = undefined, preloadWallet = false, preloadCredential = false, credentialNetwork, } = config;
        if (!__classPrivateFieldGet(this, _AirService_partnerId, "f"))
            throw new AirServiceError("CLIENT_ERROR", "Partner ID is required to initialize the service");
        if (__classPrivateFieldGet(this, _AirService_isAuthInitialized, "f"))
            return __classPrivateFieldGet(this, _AirService_loginResult, "f") ?? null;
        __classPrivateFieldSet(this, _AirService_credentialNetwork, buildEnv === BUILD_ENV.PRODUCTION ? credentialNetwork : undefined, "f");
        configureLogLevel(buildEnv, enableLogging);
        const { authUrl, walletUrl, credentialUrl } = getAirUrls(buildEnv, __classPrivateFieldGet(this, _AirService_credentialNetwork, "f"));
        addResourceHints(authUrl);
        if (preloadWallet) {
            addResourceHints(walletUrl);
        }
        if (preloadCredential) {
            addResourceHints(credentialUrl);
        }
        __classPrivateFieldSet(this, _AirService_buildEnv, buildEnv, "f");
        __classPrivateFieldSet(this, _AirService_enableLogging, enableLogging, "f");
        __classPrivateFieldSet(this, _AirService_sessionConfig, sessionConfig, "f");
        __classPrivateFieldSet(this, _AirService_sessionId, randomId(), "f");
        const authIframeOrigin = new URL(authUrl).origin;
        __classPrivateFieldSet(this, _AirService_authIframeController, new IframeController("air-auth", authUrl), "f");
        try {
            const authIframe = __classPrivateFieldGet(this, _AirService_authIframeController, "f").createIframe();
            log.info(authUrl, "url loaded");
            await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").open(authIframe);
            __classPrivateFieldGet(this, _AirService_authMessagingService, "f").messages$.subscribe(async (msg) => {
                switch (msg.type) {
                    case AirAuthMessageTypes.IFRAME_VISIBILITY_REQUEST: {
                        __classPrivateFieldGet(this, _AirService_authIframeController, "f")?.setIframeVisibility(msg.payload.visible);
                        __classPrivateFieldGet(this, _AirService_authIframeController, "f")?.updateIframeState();
                        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_refocusTopmostVisibleIframe).call(this);
                        break;
                    }
                    case AirAuthMessageTypes.SETUP_WALLET_REQUEST: {
                        try {
                            await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this, { skipWalletLogin: true });
                            await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendSetupWalletSuccessResponse();
                        }
                        catch (err) {
                            const error = ensureError(err);
                            await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendSetupWalletErrorResponse(error);
                        }
                        break;
                    }
                    case AirAuthMessageTypes.SETUP_RECOVERY_REQUEST: {
                        try {
                            await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureRecovery).call(this);
                            await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendSetupRecoverySuccessResponse();
                        }
                        catch (err) {
                            const error = ensureError(err);
                            await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendSetupRecoveryErrorResponse(error);
                        }
                        break;
                    }
                    case AirAuthMessageTypes.SETUP_CREDENTIAL_REQUEST: {
                        try {
                            await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureCredential).call(this);
                            await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendSetupCredentialSuccessResponse();
                        }
                        catch (err) {
                            const error = ensureError(err);
                            await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendSetupCredentialErrorResponse(error);
                        }
                        break;
                    }
                    case AirAuthMessageTypes.EXPIRED_LOGOUT_REQUEST: {
                        await this.logout();
                        break;
                    }
                    case AirAuthMessageTypes.LOGIN_RESPONSE: {
                        if (msg.payload.success === true) {
                            __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assignAndTriggerLoginResult).call(this, msg.payload);
                        }
                        break;
                    }
                    case AirAuthMessageTypes.LOGOUT_RESPONSE: {
                        const wasLoggedIn = !!__classPrivateFieldGet(this, _AirService_loginResult, "f");
                        __classPrivateFieldSet(this, _AirService_loginResult, undefined, "f");
                        if (wasLoggedIn)
                            __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_triggerAirAuthLoggedOut).call(this);
                        break;
                    }
                }
            });
            const result = await new Promise((resolve, reject) => {
                const handleAuthMessage = async (ev) => {
                    if (ev.origin !== authIframeOrigin)
                        return;
                    if (ev.data === AirAuthMessageTypes.AUTH_SETUP_COMPLETED) {
                        window.removeEventListener("message", handleAuthMessage);
                        // Capture before strip: the auth iframe needs the handoff code from
                        // the fragment. Strip immediately after so a refresh cannot replay a
                        // consumed one-time code (waiting until init completes left the hash
                        // in the address bar for too long).
                        const partnerDAppUrl = window.location.href;
                        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_stripGoogleRedirectParamsFromUrl).call(this);
                        const { payload } = await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendInitializationRequest({
                            sessionId: __classPrivateFieldGet(this, _AirService_sessionId, "f"),
                            partnerId: __classPrivateFieldGet(this, _AirService_partnerId, "f"),
                            skipRehydration,
                            partnerDAppUrl,
                            sdkVersion: airKitVersion,
                            enableLogging: __classPrivateFieldGet(this, _AirService_enableLogging, "f"),
                            enableAutomation: this.shouldEnableAutomation(),
                            sessionConfig,
                        });
                        if (payload.success === true) {
                            resolve(payload);
                        }
                        else {
                            reject(new AirServiceError(payload.errorName, payload.errorMessage));
                        }
                    }
                };
                window.addEventListener("message", handleAuthMessage);
            });
            __classPrivateFieldSet(this, _AirService_isAuthInitialized, true, "f");
            // Backstop: if something re-wrote the hash during init, or the early strip
            // was skipped, clear it once the flow has settled.
            __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_stripGoogleRedirectParamsFromUrl).call(this);
            __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_triggerAirAuthInitialized).call(this, { rehydrated: result.rehydrated });
            if (result.preloadWallet || preloadWallet)
                void this.preloadWallet();
            if (preloadCredential)
                void this.preloadCredential();
            // rehydrated auth session
            if (result.rehydrated) {
                return __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assignAndTriggerLoginResult).call(this, result);
            }
        }
        catch (error) {
            log.debug("Error initializing auth service", error);
            await this.cleanUp();
            throw AirServiceError.from(error);
        }
        return null;
    }
    async login(options) {
        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assertInitialized).call(this);
        if (__classPrivateFieldGet(this, _AirService_loginResult, "f"))
            return __classPrivateFieldGet(this, _AirService_loginResult, "f");
        const { payload } = await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendLoginRequest({
            partnerLoginToken: options?.authToken,
        });
        if (payload.success === true) {
            return __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assignAndTriggerLoginResult).call(this, payload);
        }
        throw new AirServiceError(payload.errorName, payload.errorMessage);
    }
    /**
     * @experimental This method is experimental and will change in the future.
     */
    async deploySmartAccount() {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this);
        log.info("deploySmartAccount");
        const { payload } = await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendDeploySmartAccountRequest();
        if (payload.success === false) {
            throw new AirServiceError(payload.errorName, payload.errorMessage);
        }
        return { txHash: payload.txHash };
    }
    /**
     * @experimental This method is experimental and will change in the future.
     */
    async isSmartAccountDeployed() {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this);
        const { payload } = await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendIsSmartAccountDeployedRequest();
        if (payload.success === false) {
            throw new AirServiceError(payload.errorName, payload.errorMessage);
        }
        return payload.isDeployed;
    }
    getProvider() {
        return this.provider;
    }
    async preloadWallet() {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this, { skipWalletLogin: true });
    }
    async setupOrUpdateMfa() {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this, { skipWalletLogin: true });
        const result = await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendSetupMfaRequest();
        if (result.payload.success === false) {
            throw new AirServiceError(result.payload.errorName, result.payload.errorMessage);
        }
        __classPrivateFieldSet(this, _AirService_loginResult, {
            ...__classPrivateFieldGet(this, _AirService_loginResult, "f"),
            isMFASetup: true,
        }, "f");
    }
    /**
     * @experimental This feature has not been officially released and might change in the future.
     */
    async claimAirId(options) {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this);
        const result = await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendClaimIdRequest(options ?? {});
        if (result.payload.success === true) {
            return { airId: result.payload.airId };
        }
        throw new AirServiceError(result.payload.errorName, result.payload.errorMessage);
    }
    /**
     * @experimental This feature has not been officially released and might change in the future.
     */
    async showSwapUI(options) {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this);
        const result = await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendShowSwapUIRequest(options);
        if (result.payload.success === false) {
            throw new AirServiceError(result.payload.errorName, result.payload.errorMessage);
        }
        return result.payload;
    }
    /**
     * @experimental This feature has not been officially released and might change in the future.
     */
    async showOnRampUI(options) {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this);
        const result = await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendShowOnRampUIRequest(options);
        if (result.payload.success === false) {
            throw new AirServiceError(result.payload.errorName, result.payload.errorMessage);
        }
    }
    /**
     * @experimental This feature has not been officially released and might change in the future.
     */
    async showTransferUI(options) {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this);
        const result = await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendShowTransferUIRequest(options);
        if (result.payload.success === false) {
            throw new AirServiceError(result.payload.errorName, result.payload.errorMessage);
        }
        return {
            txHash: result.payload.txHash,
            symbol: result.payload.symbol,
            chainId: result.payload.chainId,
            decimals: result.payload.decimals,
            address: result.payload.address,
            recipientAddress: result.payload.recipientAddress,
            amount: result.payload.amount,
        };
    }
    /**
     * @experimental This feature has not been officially released and might change in the future.
     */
    async showReceiveUI() {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this);
        const result = await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendShowReceiveUIRequest();
        if (result.payload.success === false) {
            if (result.payload.errorName === "USER_CANCELLED")
                return;
            throw new AirServiceError(result.payload.errorName, result.payload.errorMessage);
        }
    }
    async getAgentKeys() {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureRecovery).call(this);
        const { payload } = await __classPrivateFieldGet(this, _AirService_recoveryMessagingService, "f").sendGetAgentKeysRequest();
        if (payload.success === false) {
            throw new AirServiceError(payload.errorName, payload.errorMessage);
        }
        return payload.agentKeys;
    }
    async registerAgentKey(publicKey) {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureRecovery).call(this);
        const { payload } = await __classPrivateFieldGet(this, _AirService_recoveryMessagingService, "f").sendRegisterAgentKeyRequest({
            publicKey,
        });
        if (payload.success === false) {
            throw new AirServiceError(payload.errorName, payload.errorMessage);
        }
        return {
            id: payload.id,
            publicKey: payload.publicKey,
            createdAt: payload.createdAt,
        };
    }
    async removeAgentKey(id) {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureRecovery).call(this);
        const { payload } = await __classPrivateFieldGet(this, _AirService_recoveryMessagingService, "f").sendRemoveAgentKeyRequest({ id });
        if (payload.success === false) {
            throw new AirServiceError(payload.errorName, payload.errorMessage);
        }
    }
    async getUserInfo() {
        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assertLoggedIn).call(this);
        const info = await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendPartnerUserInfoRequest();
        if (info.payload.success === false) {
            throw new AirServiceError(info.payload.errorName, info.payload.errorMessage);
        }
        return {
            partnerId: info.payload.partnerId,
            airId: info.payload.airId,
            user: {
                id: info.payload.user.id,
                abstractAccountAddress: info.payload.user.abstractAccountAddress,
                email: info.payload.user.email,
                wallet: info.payload.user.wallet,
                isMFASetup: (info.payload.user.activeMfaMethods?.length ?? 0) > 0,
            },
        };
    }
    async updateSessionConfig(config) {
        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assertInitialized).call(this);
        __classPrivateFieldSet(this, _AirService_sessionConfig, config, "f");
        const resultsPromise = [__classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendUpdateSessionConfigRequest(config)];
        if (__classPrivateFieldGet(this, _AirService_walletInitialization, "f")) {
            resultsPromise.push(__classPrivateFieldGet(this, _AirService_walletInitialization, "f")
                .then(() => __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendUpdateSessionConfigRequest(config))
                .catch(() => null));
        }
        if (__classPrivateFieldGet(this, _AirService_recoveryInitialization, "f")) {
            resultsPromise.push(__classPrivateFieldGet(this, _AirService_recoveryInitialization, "f")
                .then(() => __classPrivateFieldGet(this, _AirService_recoveryMessagingService, "f").sendUpdateSessionConfigRequest(config))
                .catch(() => null));
        }
        if (__classPrivateFieldGet(this, _AirService_credentialsInitialization, "f")) {
            resultsPromise.push(__classPrivateFieldGet(this, _AirService_credentialsInitialization, "f")
                .then(() => __classPrivateFieldGet(this, _AirService_credentialMessagingService, "f").sendUpdateSessionConfigRequest(config))
                .catch(() => null));
        }
        const results = await Promise.all(resultsPromise);
        for (const result of results) {
            if (result && result.payload.success === false) {
                throw new AirServiceError(result.payload.errorName, result.payload.errorMessage);
            }
        }
        const first = results[0];
        if (!first) {
            throw new AirServiceError("CLIENT_ERROR", "No session config response");
        }
        const sessionConfig = {
            locale: first.payload.locale,
            currency: first.payload.currency,
        };
        __classPrivateFieldSet(this, _AirService_sessionConfig, sessionConfig, "f");
        return sessionConfig;
    }
    async goToPartner(partnerUrl) {
        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assertLoggedIn).call(this);
        const result = await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendCrossPartnerTokenRequest(partnerUrl);
        if (result.payload.success === false) {
            throw new AirServiceError(result.payload.errorName, result.payload.errorMessage);
        }
        return {
            urlWithToken: result.payload.urlWithToken,
        };
    }
    async startRecovery(payload) {
        const result = await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendAccountRecoveryRequest(payload);
        if (result.payload.success === false) {
            throw new AirServiceError(result.payload.errorName, result.payload.errorMessage);
        }
    }
    async getAccessToken() {
        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assertLoggedIn).call(this);
        const result = await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").sendPartnerAccessTokenRequest();
        if (result.payload.success !== true) {
            throw new AirServiceError(result.payload.errorName, result.payload.errorMessage);
        }
        if (!result.payload.partnerAccessToken) {
            throw new AirServiceError("UNAUTHORIZED", "Partner access token not found in response");
        }
        return { token: result.payload.partnerAccessToken };
    }
    async logout() {
        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assertLoggedIn).call(this);
        // Clear up credentials first to avoid issues with wallet and auth messaging services
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_cleanUpCredential).call(this);
        await Promise.all([
            __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_cleanUpWallet).call(this),
            __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_cleanUpRecovery).call(this),
            __classPrivateFieldGet(this, _AirService_authMessagingService, "f").logout(),
        ]);
    }
    async cleanUp() {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_cleanUpCredential).call(this);
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_cleanUpRecovery).call(this);
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_cleanUpWallet).call(this);
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_cleanUpAuth).call(this);
        __classPrivateFieldSet(this, _AirService_airEventListener, [], "f");
        __classPrivateFieldSet(this, _AirService_sessionId, undefined, "f");
        __classPrivateFieldSet(this, _AirService_buildEnv, undefined, "f");
    }
    on(listener) {
        if (__classPrivateFieldGet(this, _AirService_airEventListener, "f").indexOf(listener) < 0)
            __classPrivateFieldGet(this, _AirService_airEventListener, "f").push(listener);
    }
    off(listener) {
        if (__classPrivateFieldGet(this, _AirService_airEventListener, "f").indexOf(listener) >= 0)
            __classPrivateFieldGet(this, _AirService_airEventListener, "f").splice(__classPrivateFieldGet(this, _AirService_airEventListener, "f").indexOf(listener), 1);
    }
    async preloadCredential() {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureCredential).call(this);
    }
    /**
     * @param headless When true, never shows the credential UI: confirmation is
     * granted and the result is returned automatically. Where the interactive flow
     * would prompt to reissue an existing on-chain credential, headless resolves
     * without reissuing. Errors that would otherwise require a user-facing CTA
     * reject the returned promise instead.
     */
    async issueCredential({ authToken, issuerDid, credentialId, credentialSubject, curve, waitForOnchainCompletion, headless, }) {
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureCredential).call(this);
        const response = await __classPrivateFieldGet(this, _AirService_credentialMessagingService, "f").sendIssueCredentialRequest({
            partnerToken: authToken,
            issuerDid,
            credentialId,
            credentialSubject,
            curve,
            waitForOnchainCompletion,
            headless,
        });
        const { payload } = response;
        if (payload.closeDApp) {
            window.close();
        }
        if (payload.success === false) {
            throw new AirServiceError(payload.errorName, payload.errorMessage);
        }
        return {
            cakPublicKey: payload.cakPublicKey,
        };
    }
    /**
     * @param headless When true, never shows the credential UI: consent is granted,
     * disclosure (if `fieldsToDisclose` is set) is signed, and the result is returned
     * automatically. `redirectUrl` is ignored in this mode. Errors that would otherwise
     * require a user-facing CTA (e.g. an unrecoverable technical failure) reject the
     * returned promise instead.
     * @param nonce Challenge for SD-JWT key binding. Required for `SD_JWT_VC`
     *   programs; ignored for other program types. Bound into the key-binding JWT
     *   as `nonce`
     */
    async verifyCredential({ authToken, programId, redirectUrl, fieldsToDisclose, nonce, headless, }) {
        if (Array.isArray(fieldsToDisclose) && fieldsToDisclose.length === 0) {
            throw new AirServiceError("CLIENT_ERROR", "fieldsToDisclose array must contain at least one field");
        }
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureCredential).call(this);
        const { payload } = await __classPrivateFieldGet(this, _AirService_credentialMessagingService, "f").sendVerifyCredentialRequest({
            partnerToken: authToken,
            programId,
            redirectUrl,
            fieldsToDisclose,
            nonce,
            headless,
        });
        if (payload.success === false) {
            throw new AirServiceError(payload.errorName, payload.errorMessage);
        }
        return payload.verificationResult;
    }
}
_AirService_loginResult = new WeakMap(), _AirService_buildEnv = new WeakMap(), _AirService_enableLogging = new WeakMap(), _AirService_partnerId = new WeakMap(), _AirService_sessionId = new WeakMap(), _AirService_sessionConfig = new WeakMap(), _AirService_authMessagingService = new WeakMap(), _AirService_authIframeController = new WeakMap(), _AirService_isAuthInitialized = new WeakMap(), _AirService_airEventListener = new WeakMap(), _AirService_walletMessagingService = new WeakMap(), _AirService_walletIframeController = new WeakMap(), _AirService_walletInitialization = new WeakMap(), _AirService_walletLoggedInResult = new WeakMap(), _AirService_airWalletProvider = new WeakMap(), _AirService_recoveryInitialization = new WeakMap(), _AirService_recoveryMessagingService = new WeakMap(), _AirService_recoveryIframeController = new WeakMap(), _AirService_credentialsInitialization = new WeakMap(), _AirService_credentialMessagingService = new WeakMap(), _AirService_credentialIframeController = new WeakMap(), _AirService_credentialNetwork = new WeakMap(), _AirService_instances = new WeakSet(), _AirService_stripGoogleRedirectParamsFromUrl = function _AirService_stripGoogleRedirectParamsFromUrl() {
    try {
        const url = new URL(window.location.href);
        let changed = false;
        if (url.searchParams.has("airkit_login_error")) {
            url.searchParams.delete("airkit_login_error");
            changed = true;
        }
        // Preserve the fragment unless we are removing `airkit_handoff`. Running
        // hash-router / anchor fragments (#/route, #section) through
        // URLSearchParams.toString() rewrites them (e.g. #/route → #%2Froute=).
        let hashSuffix = url.hash;
        const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
        if (rawHash) {
            const hashParams = new URLSearchParams(rawHash);
            if (hashParams.has("airkit_handoff")) {
                hashParams.delete("airkit_handoff");
                const remaining = hashParams.toString();
                hashSuffix = remaining ? `#${remaining}` : "";
                changed = true;
            }
        }
        if (!changed)
            return;
        // Prefer pathname + search (+ hash) over url.toString(). Passing a full
        // absolute URL to replaceState is flaky for fragment removal in some
        // WebKit builds; this form reliably updates the address bar.
        const next = url.pathname + url.search + hashSuffix;
        window.history.replaceState(window.history.state, "", next);
    }
    catch (error) {
        log.warn("Failed to strip Google redirect params from URL", error);
    }
}, _AirService_assertInitialized = function _AirService_assertInitialized() {
    if (!__classPrivateFieldGet(this, _AirService_isAuthInitialized, "f"))
        throw new AirServiceError("NOT_INITIALIZED", "Service is not initialized");
}, _AirService_assertLoggedIn = function _AirService_assertLoggedIn() {
    __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assertInitialized).call(this);
    if (!this.isLoggedIn)
        throw new AirServiceError("NOT_LOGGED_IN", "User not logged in");
}, _AirService_getBuildEnv = function _AirService_getBuildEnv() {
    if (!__classPrivateFieldGet(this, _AirService_buildEnv, "f")) {
        throw new AirServiceError("NOT_INITIALIZED", "Service is not initialized");
    }
    return __classPrivateFieldGet(this, _AirService_buildEnv, "f");
}, _AirService_ensureCredential = async function _AirService_ensureCredential() {
    __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assertInitialized).call(this);
    void __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this, { skipWalletLogin: true });
    try {
        if (!__classPrivateFieldGet(this, _AirService_credentialsInitialization, "f"))
            __classPrivateFieldSet(this, _AirService_credentialsInitialization, __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_initializeCredentials).call(this), "f");
        await __classPrivateFieldGet(this, _AirService_credentialsInitialization, "f");
    }
    catch (error) {
        __classPrivateFieldSet(this, _AirService_credentialsInitialization, undefined, "f");
        log.error("Error ensuring credentials", error);
        throw AirServiceError.from(error);
    }
}, _AirService_initializeCredentials = async function _AirService_initializeCredentials() {
    if (__classPrivateFieldGet(this, _AirService_credentialsInitialization, "f")) {
        throw new AirServiceError("ALREADY_INITIALIZING", "Already initializing credentials");
    }
    const { credentialUrl } = getAirUrls(__classPrivateFieldGet(this, _AirService_instances, "m", _AirService_getBuildEnv).call(this), __classPrivateFieldGet(this, _AirService_credentialNetwork, "f"));
    const credentialIframeOrigin = new URL(credentialUrl).origin;
    let closeDApp = false;
    try {
        const credentialInitRequestPromise = new Promise((resolve, reject) => {
            const handleCredentialMessage = async (ev) => {
                if (ev.origin !== credentialIframeOrigin)
                    return;
                if (ev.data === AirCredentialMessageTypes.SERVICE_STARTED) {
                    window.removeEventListener("message", handleCredentialMessage);
                    const { payload } = await __classPrivateFieldGet(this, _AirService_credentialMessagingService, "f").sendInitializationRequest({
                        sessionId: __classPrivateFieldGet(this, _AirService_sessionId, "f"),
                        partnerId: __classPrivateFieldGet(this, _AirService_partnerId, "f"),
                        enableLogging: __classPrivateFieldGet(this, _AirService_enableLogging, "f"),
                        sdkVersion: airKitVersion,
                        partnerDAppUrl: window.location.href,
                        enableAutomation: this.shouldEnableAutomation(),
                        sessionConfig: __classPrivateFieldGet(this, _AirService_sessionConfig, "f"),
                        ...(__classPrivateFieldGet(this, _AirService_credentialNetwork, "f") && { credentialNetwork: __classPrivateFieldGet(this, _AirService_credentialNetwork, "f") }),
                    });
                    if (payload.success === true) {
                        resolve();
                    }
                    else {
                        closeDApp = !!payload.closeDApp;
                        reject(new AirServiceError(payload.errorName, payload.errorMessage));
                    }
                }
            };
            window.addEventListener("message", handleCredentialMessage);
        });
        __classPrivateFieldSet(this, _AirService_credentialIframeController, new IframeController("air-credential", credentialUrl), "f");
        const credentialIframe = __classPrivateFieldGet(this, _AirService_credentialIframeController, "f").createIframe();
        log.info(credentialUrl, "url loaded");
        await __classPrivateFieldGet(this, _AirService_credentialMessagingService, "f").open(credentialIframe);
        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_subscribeToCredentialEvents).call(this);
        await credentialInitRequestPromise;
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this, { skipWalletLogin: true });
        void __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_ensureWallet).call(this); // this call triggers wallet login for later usage
        log.info("Credential service initialized successfully");
    }
    catch (error) {
        log.error("Error initializing credentials", error);
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_cleanUpCredential).call(this);
        if (closeDApp) {
            window.close();
        }
        throw AirServiceError.from(error);
    }
}, _AirService_subscribeToCredentialEvents = function _AirService_subscribeToCredentialEvents() {
    __classPrivateFieldGet(this, _AirService_credentialMessagingService, "f").messages$.subscribe(async (message) => {
        switch (message.type) {
            case AirCredentialMessageTypes.CREDENTIAL_IFRAME_VISIBILITY_REQUEST: {
                __classPrivateFieldGet(this, _AirService_credentialIframeController, "f")?.setIframeVisibility(message.payload.visible);
                __classPrivateFieldGet(this, _AirService_credentialIframeController, "f")?.updateIframeState();
                __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_refocusTopmostVisibleIframe).call(this);
                break;
            }
        }
    });
}, _AirService_cleanUpCredential = async function _AirService_cleanUpCredential() {
    if (!__classPrivateFieldGet(this, _AirService_isAuthInitialized, "f"))
        return;
    const credentialController = __classPrivateFieldGet(this, _AirService_credentialIframeController, "f");
    const credentialIframeElement = credentialController?.iframeElement;
    if (credentialController &&
        isElement(credentialIframeElement) &&
        window.document.body.contains(credentialIframeElement)) {
        await __classPrivateFieldGet(this, _AirService_credentialMessagingService, "f").logout();
        credentialController.destroy();
        __classPrivateFieldSet(this, _AirService_credentialIframeController, undefined, "f");
    }
    await __classPrivateFieldGet(this, _AirService_credentialMessagingService, "f").close();
    __classPrivateFieldSet(this, _AirService_credentialsInitialization, undefined, "f");
}, _AirService_ensureWallet = async function _AirService_ensureWallet(option) {
    __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assertInitialized).call(this);
    if (!__classPrivateFieldGet(this, _AirService_walletInitialization, "f"))
        __classPrivateFieldSet(this, _AirService_walletInitialization, __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_initializeWallet).call(this, option), "f");
    if (__classPrivateFieldGet(this, _AirService_walletLoggedInResult, "f"))
        return __classPrivateFieldGet(this, _AirService_walletLoggedInResult, "f");
    try {
        const result = await __classPrivateFieldGet(this, _AirService_walletInitialization, "f");
        if (option?.skipWalletLogin || result.isWalletLoggedIn) {
            return __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_createWalletInitializedResult).call(this, result);
        }
    }
    catch (error) {
        __classPrivateFieldSet(this, _AirService_walletInitialization, undefined, "f");
        log.error("Error initializing wallet", error);
        throw AirServiceError.from(error);
    }
    if (__classPrivateFieldGet(this, _AirService_walletLoggedInResult, "f"))
        return __classPrivateFieldGet(this, _AirService_walletLoggedInResult, "f");
    const walletLoginResult = await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendLoginRequest();
    if (walletLoginResult.payload.success !== true) {
        throw new AirServiceError(walletLoginResult.payload.errorName, walletLoginResult.payload.errorMessage);
    }
    return __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_createWalletInitializedResult).call(this, walletLoginResult.payload);
}, _AirService_initializeWallet = async function _AirService_initializeWallet(option) {
    if (__classPrivateFieldGet(this, _AirService_walletInitialization, "f"))
        throw new AirServiceError("ALREADY_INITIALIZING", "Already initializing");
    const { walletUrl } = getAirUrls(__classPrivateFieldGet(this, _AirService_instances, "m", _AirService_getBuildEnv).call(this), __classPrivateFieldGet(this, _AirService_credentialNetwork, "f"));
    const walletIframeOrigin = new URL(walletUrl).origin;
    try {
        const walletInitRequestPromise = new Promise((resolve, reject) => {
            const handleWalletMessage = async (ev) => {
                if (ev.origin !== walletIframeOrigin)
                    return;
                if (ev.data === AirWalletMessageTypes.SERVICE_STARTED) {
                    window.removeEventListener("message", handleWalletMessage);
                    const { payload } = await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendInitializationRequest({
                        sessionId: __classPrivateFieldGet(this, _AirService_sessionId, "f"),
                        partnerId: __classPrivateFieldGet(this, _AirService_partnerId, "f"),
                        partnerDAppUrl: window.location.href,
                        enableLogging: __classPrivateFieldGet(this, _AirService_enableLogging, "f"),
                        sdkVersion: airKitVersion,
                        enableAutomation: this.shouldEnableAutomation(),
                        sessionConfig: __classPrivateFieldGet(this, _AirService_sessionConfig, "f"),
                    });
                    if (payload.success === true) {
                        resolve();
                    }
                    else {
                        reject(new AirServiceError(payload.errorName, payload.errorMessage));
                    }
                }
            };
            window.addEventListener("message", handleWalletMessage);
        });
        __classPrivateFieldSet(this, _AirService_walletIframeController, new IframeController("air-wallet", walletUrl), "f");
        const walletIframe = __classPrivateFieldGet(this, _AirService_walletIframeController, "f").createIframe();
        log.info(walletUrl, "url loaded");
        await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").open(walletIframe);
        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_subscribeToWalletEvents).call(this);
        await __classPrivateFieldGet(this, _AirService_airWalletProvider, "f").startEventMessageListening(walletIframe);
        const walletInitPromise = __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").onInitialized();
        await walletInitRequestPromise;
        if (!this.isLoggedIn && !option?.skipWalletLogin) {
            await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").onLoggedIn();
        }
        const walletInitResult = await walletInitPromise;
        if (walletInitResult.payload.success !== true) {
            throw new AirServiceError(walletInitResult.payload.errorName, walletInitResult.payload.errorMessage);
        }
        if (!__classPrivateFieldGet(this, _AirService_walletLoggedInResult, "f") && walletInitResult.payload.isWalletLoggedIn) {
            __classPrivateFieldSet(this, _AirService_walletLoggedInResult, __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_createWalletInitializedResult).call(this, walletInitResult.payload), "f");
            __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_triggerWalletInitialized).call(this, __classPrivateFieldGet(this, _AirService_walletLoggedInResult, "f"));
        }
        return walletInitResult.payload;
    }
    catch (error) {
        log.error("Error initializing wallet", error);
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_cleanUpWallet).call(this);
        throw AirServiceError.from(error);
    }
}, _AirService_subscribeToWalletEvents = function _AirService_subscribeToWalletEvents() {
    __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").messages$.subscribe(async (msg) => {
        switch (msg.type) {
            case AirWalletMessageTypes.WALLET_IFRAME_VISIBILITY_REQUEST: {
                __classPrivateFieldGet(this, _AirService_walletIframeController, "f")?.setIframeVisibility(msg.payload.visible);
                __classPrivateFieldGet(this, _AirService_walletIframeController, "f")?.updateIframeState();
                __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_refocusTopmostVisibleIframe).call(this);
                break;
            }
            case AirWalletMessageTypes.WALLET_LOGIN_RESPONSE: {
                if (msg.payload.success === true && !__classPrivateFieldGet(this, _AirService_walletLoggedInResult, "f")) {
                    __classPrivateFieldSet(this, _AirService_walletLoggedInResult, __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_createWalletInitializedResult).call(this, msg.payload), "f");
                    __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_triggerWalletInitialized).call(this, __classPrivateFieldGet(this, _AirService_walletLoggedInResult, "f"));
                }
                break;
            }
            case AirWindowMessageTypes.OPEN_WINDOW_REQUEST: {
                try {
                    const onRetry = async () => {
                        const { payload } = await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendOpenWindowRetryRequest(msg.payload.windowId);
                        if (payload.success === false) {
                            throw new AirServiceError(payload.errorName, payload.errorMessage);
                        }
                    };
                    const { windowController, port } = await WindowService.openAndInitializeWalletServiceWindow({
                        url: msg.payload.url,
                        windowId: msg.payload.windowId,
                        sessionId: __classPrivateFieldGet(this, _AirService_sessionId, "f"),
                        partnerId: __classPrivateFieldGet(this, _AirService_partnerId, "f"),
                        enableLogging: __classPrivateFieldGet(this, _AirService_enableLogging, "f"),
                        sdkVersion: airKitVersion,
                        enableAutomation: this.shouldEnableAutomation(),
                        onRetry,
                    });
                    windowController.onClose(async () => await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendWindowClosed(msg.payload.windowId));
                    await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendOpenWindowSuccessResponse(msg.payload.windowId, port);
                }
                catch (err) {
                    const error = ensureError(err);
                    await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").sendOpenWindowErrorResponse(msg.payload.windowId, error);
                }
                break;
            }
        }
    });
}, _AirService_triggerEventListeners = function _AirService_triggerEventListeners(data) {
    __classPrivateFieldGet(this, _AirService_airEventListener, "f").forEach((listener) => {
        listener(data);
    });
}, _AirService_triggerAirAuthInitialized = function _AirService_triggerAirAuthInitialized(result) {
    __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_triggerEventListeners).call(this, { event: "initialized", result });
}, _AirService_triggerAirAuthLoggedIn = function _AirService_triggerAirAuthLoggedIn() {
    const loginResult = __classPrivateFieldGet(this, _AirService_loginResult, "f");
    if (!loginResult)
        return;
    __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_triggerEventListeners).call(this, {
        event: "logged_in",
        result: loginResult,
    });
}, _AirService_triggerAirAuthLoggedOut = function _AirService_triggerAirAuthLoggedOut() {
    __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_triggerEventListeners).call(this, { event: "logged_out" });
}, _AirService_triggerWalletInitialized = function _AirService_triggerWalletInitialized(result) {
    __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_triggerEventListeners).call(this, {
        event: "wallet_initialized",
        result,
    });
}, _AirService_assignAndTriggerLoginResult = function _AirService_assignAndTriggerLoginResult(payload) {
    if (!__classPrivateFieldGet(this, _AirService_loginResult, "f")) {
        __classPrivateFieldSet(this, _AirService_loginResult, {
            isLoggedIn: true,
            id: payload.id,
            abstractAccountAddress: payload.abstractAccountAddress,
            abstractAccountAddresses: payload.abstractAccountAddresses,
            token: payload.partnerAccessToken,
            isMFASetup: (payload.activeMfaMethods?.length ?? 0) > 0,
        }, "f");
        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_triggerAirAuthLoggedIn).call(this);
    }
    return __classPrivateFieldGet(this, _AirService_loginResult, "f");
}, _AirService_createWalletInitializedResult = function _AirService_createWalletInitializedResult(payload) {
    if ("isWalletLoggedIn" in payload && !payload.isWalletLoggedIn) {
        return {
            abstractAccountAddress: null,
            isMFASetup: __classPrivateFieldGet(this, _AirService_loginResult, "f")?.isMFASetup ?? false,
        };
    }
    return {
        abstractAccountAddress: payload.addresses.aa,
        isMFASetup: (payload.activeMfaMethods?.length ?? 0) > 0,
    };
}, _AirService_cleanUpAuth = async function _AirService_cleanUpAuth() {
    // Logout auth session
    await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").logout();
    // Destroy the auth iframe
    const authController = __classPrivateFieldGet(this, _AirService_authIframeController, "f");
    const authIframeElement = authController?.iframeElement;
    if (authController &&
        isElement(authIframeElement) &&
        window.document.body.contains(authIframeElement)) {
        authController.destroy();
        __classPrivateFieldSet(this, _AirService_authIframeController, undefined, "f");
    }
    // Close the message service
    await __classPrivateFieldGet(this, _AirService_authMessagingService, "f").close();
    __classPrivateFieldSet(this, _AirService_isAuthInitialized, false, "f");
}, _AirService_cleanUpWallet = async function _AirService_cleanUpWallet() {
    if (!__classPrivateFieldGet(this, _AirService_isAuthInitialized, "f"))
        return;
    // Logout wallet and destroy the wallet iframe
    const walletController = __classPrivateFieldGet(this, _AirService_walletIframeController, "f");
    const walletIframeElement = walletController?.iframeElement;
    if (walletController &&
        isElement(walletIframeElement) &&
        window.document.body.contains(walletIframeElement)) {
        await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").logout();
        walletController.destroy();
        __classPrivateFieldSet(this, _AirService_walletIframeController, undefined, "f");
    }
    // Close the message service
    await __classPrivateFieldGet(this, _AirService_walletMessagingService, "f").close();
    __classPrivateFieldSet(this, _AirService_walletLoggedInResult, undefined, "f");
    __classPrivateFieldSet(this, _AirService_walletInitialization, undefined, "f");
}, _AirService_ensureRecovery = async function _AirService_ensureRecovery() {
    __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_assertInitialized).call(this);
    if (!__classPrivateFieldGet(this, _AirService_recoveryInitialization, "f")) {
        __classPrivateFieldSet(this, _AirService_recoveryInitialization, __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_initializeRecovery).call(this), "f");
    }
    try {
        await __classPrivateFieldGet(this, _AirService_recoveryInitialization, "f");
    }
    catch (error) {
        __classPrivateFieldSet(this, _AirService_recoveryInitialization, undefined, "f");
        log.error("Error initializing recovery", error);
        throw AirServiceError.from(error);
    }
}, _AirService_initializeRecovery = async function _AirService_initializeRecovery() {
    if (__classPrivateFieldGet(this, _AirService_recoveryInitialization, "f"))
        throw new AirServiceError("ALREADY_INITIALIZING", "Already initializing");
    const { recoveryUrl } = getAirUrls(__classPrivateFieldGet(this, _AirService_instances, "m", _AirService_getBuildEnv).call(this), __classPrivateFieldGet(this, _AirService_credentialNetwork, "f"));
    const recoveryIframeOrigin = new URL(recoveryUrl).origin;
    try {
        const recoveryInitRequestPromise = new Promise((resolve, reject) => {
            const handleRecoveryMessage = async (ev) => {
                if (ev.origin !== recoveryIframeOrigin)
                    return;
                if (ev.data === AirRecoveryMessageTypes.SERVICE_STARTED) {
                    window.removeEventListener("message", handleRecoveryMessage);
                    const { payload } = await __classPrivateFieldGet(this, _AirService_recoveryMessagingService, "f").sendInitializationRequest({
                        sessionId: __classPrivateFieldGet(this, _AirService_sessionId, "f"),
                        partnerId: __classPrivateFieldGet(this, _AirService_partnerId, "f"),
                        partnerDAppUrl: window.location.href,
                        enableLogging: __classPrivateFieldGet(this, _AirService_enableLogging, "f"),
                        sdkVersion: airKitVersion,
                        enableAutomation: this.shouldEnableAutomation(),
                        sessionConfig: __classPrivateFieldGet(this, _AirService_sessionConfig, "f"),
                    });
                    if (payload.success === true) {
                        resolve();
                    }
                    else {
                        reject(new AirServiceError(payload.errorName, payload.errorMessage));
                    }
                }
            };
            window.addEventListener("message", handleRecoveryMessage);
        });
        __classPrivateFieldSet(this, _AirService_recoveryIframeController, new IframeController("air-recovery", recoveryUrl), "f");
        const recoveryIframe = __classPrivateFieldGet(this, _AirService_recoveryIframeController, "f").createIframe();
        log.info(recoveryUrl, "url loaded");
        await __classPrivateFieldGet(this, _AirService_recoveryMessagingService, "f").open(recoveryIframe);
        __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_subscribeToRecoveryEvents).call(this);
        const recoveryInitPromise = __classPrivateFieldGet(this, _AirService_recoveryMessagingService, "f").onInitialized();
        await recoveryInitRequestPromise;
        await recoveryInitPromise;
    }
    catch (error) {
        log.error("Error initializing recovery", error);
        await __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_cleanUpRecovery).call(this);
        throw AirServiceError.from(error);
    }
}, _AirService_subscribeToRecoveryEvents = function _AirService_subscribeToRecoveryEvents() {
    __classPrivateFieldGet(this, _AirService_recoveryMessagingService, "f").messages$.subscribe(async (message) => {
        switch (message.type) {
            case AirRecoveryMessageTypes.RECOVERY_IFRAME_VISIBILITY_REQUEST: {
                __classPrivateFieldGet(this, _AirService_recoveryIframeController, "f")?.setIframeVisibility(message.payload.visible);
                __classPrivateFieldGet(this, _AirService_recoveryIframeController, "f")?.updateIframeState();
                __classPrivateFieldGet(this, _AirService_instances, "m", _AirService_refocusTopmostVisibleIframe).call(this);
                break;
            }
        }
    });
}, _AirService_cleanUpRecovery = async function _AirService_cleanUpRecovery() {
    if (!__classPrivateFieldGet(this, _AirService_isAuthInitialized, "f"))
        return;
    // Logout recovery and destroy the recovery iframe
    const recoveryController = __classPrivateFieldGet(this, _AirService_recoveryIframeController, "f");
    const recoveryIframeElement = recoveryController?.iframeElement;
    if (recoveryController &&
        isElement(recoveryIframeElement) &&
        window.document.body.contains(recoveryIframeElement)) {
        await __classPrivateFieldGet(this, _AirService_recoveryMessagingService, "f").logout();
        recoveryController.destroy();
        __classPrivateFieldSet(this, _AirService_recoveryIframeController, undefined, "f");
    }
    // Close the message service
    await __classPrivateFieldGet(this, _AirService_recoveryMessagingService, "f").close();
    __classPrivateFieldSet(this, _AirService_recoveryInitialization, undefined, "f");
}, _AirService_refocusTopmostVisibleIframe = function _AirService_refocusTopmostVisibleIframe() {
    const candidates = [
        __classPrivateFieldGet(this, _AirService_walletIframeController, "f"),
        __classPrivateFieldGet(this, _AirService_credentialIframeController, "f"),
        __classPrivateFieldGet(this, _AirService_authIframeController, "f"),
        __classPrivateFieldGet(this, _AirService_recoveryIframeController, "f"),
    ];
    for (const controller of candidates) {
        if (controller?.isVisible) {
            controller.focus();
            return;
        }
    }
};

export { AirService, AirServiceError, BUILD_ENV, ChainDisconnectedError, IFRAME_NAME_PREFIX_SET, InternalRpcError, InvalidParamsRpcError, InvalidRequestRpcError, MethodNotFoundRpcError, ProviderDisconnectedError, ProviderRpcError, SwitchChainError, TransactionRejectedRpcError, UnauthorizedProviderError, UnsupportedProviderMethodError, UserRejectedRequestError, ensureProviderRpcError, mocaDevnet, mocaMainnet, mocaTestnet };
