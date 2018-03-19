'use strict';

/*
 * Emulate 'eth_accounts' / 'eth_sendTransaction' using 'eth_sendRawTransaction'
 *
 * The two callbacks a user needs to implement are:
 * - getAccounts() -- array of addresses supported
 * - signTransaction(tx) -- sign a raw transaction object
 */

var waterfall = require('async/waterfall');
var parallel = require('async/parallel');
var inherits = require('util').inherits;
var ethUtil = require('ethereumjs-util');
var sigUtil = require('eth-sig-util');
var extend = require('xtend');
var Semaphore = require('semaphore');
var Subprovider = require('./subprovider.js');
var estimateGas = require('../util/estimate-gas.js');
var hexRegex = /^[0-9A-Fa-f]+$/g;

module.exports = HookedWalletSubprovider;

// handles the following RPC methods:
//   eth_coinbase
//   eth_accounts
//   eth_sendTransaction
//   eth_sign
//   personal_sign
//   personal_ecRecover

//
// Tx Signature Flow
//
// handleRequest: eth_sendTransaction
//   validateTransaction (basic validity check)
//     validateSender (checks that sender is in accounts)
//   processTransaction (sign tx and submit to network)
//     approveTransaction (UI approval hook)
//     checkApproval
//     finalizeAndSubmitTx (tx signing)
//       nonceLock.take (bottle neck to ensure atomic nonce)
//         fillInTxExtras (set fallback gasPrice, nonce, etc)
//         signTransaction (perform the signature)
//         publishTransaction (publish signed tx to network)
//


inherits(HookedWalletSubprovider, Subprovider);

function HookedWalletSubprovider(opts) {
  var self = this;
  // control flow
  self.nonceLock = Semaphore(1);

  // data lookup
  if (!opts.getAccounts) throw new Error('ProviderEngine - HookedWalletSubprovider - did not provide "getAccounts" fn in constructor options');
  self.getAccounts = opts.getAccounts;
  // high level override
  if (opts.processTransaction) self.processTransaction = opts.processTransaction;
  if (opts.processMessage) self.processMessage = opts.processMessage;
  if (opts.processPersonalMessage) self.processPersonalMessage = opts.processPersonalMessage;
  if (opts.processTypedMessage) self.processTypedMessage = opts.processTypedMessage;
  // approval hooks
  self.approveTransaction = opts.approveTransaction || self.autoApprove;
  self.approveMessage = opts.approveMessage || self.autoApprove;
  self.approvePersonalMessage = opts.approvePersonalMessage || self.autoApprove;
  self.approveTypedMessage = opts.approveTypedMessage || self.autoApprove;
  // actually perform the signature
  if (opts.signTransaction) self.signTransaction = opts.signTransaction;
  if (opts.signMessage) self.signMessage = opts.signMessage;
  if (opts.signPersonalMessage) self.signPersonalMessage = opts.signPersonalMessage;
  if (opts.signTypedMessage) self.signTypedMessage = opts.signTypedMessage;
  if (opts.recoverPersonalSignature) self.recoverPersonalSignature = opts.recoverPersonalSignature;
  // publish to network
  if (opts.publishTransaction) self.publishTransaction = opts.publishTransaction;
}

HookedWalletSubprovider.prototype.handleRequest = function (payload, next, end) {
  var self = this;

  switch (payload.method) {

    case 'eth_coinbase':
      self.getAccounts(function (err, accounts) {
        if (err) return end(err);
        var result = accounts[0] || null;
        end(null, result);
      });
      return;

    case 'eth_accounts':
      self.getAccounts(function (err, accounts) {
        if (err) return end(err);
        end(null, accounts);
      });
      return;

    case 'eth_sendTransaction':
      var txParams = payload.params[0];
      waterfall([function (cb) {
        return self.validateTransaction(txParams, cb);
      }, function (cb) {
        return self.processTransaction(txParams, cb);
      }], end);
      return;

    case 'eth_signTransaction':
      var txParams = payload.params[0];
      waterfall([function (cb) {
        return self.validateTransaction(txParams, cb);
      }, function (cb) {
        return self.processSignTransaction(txParams, cb);
      }], end);
      return;

    case 'eth_sign':
      var address = payload.params[0];
      var message = payload.params[1];
      // non-standard "extraParams" to be appended to our "msgParams" obj
      // good place for metadata
      var extraParams = payload.params[2] || {};
      var msgParams = extend(extraParams, {
        from: address,
        data: message
      });
      waterfall([function (cb) {
        return self.validateMessage(msgParams, cb);
      }, function (cb) {
        return self.processMessage(msgParams, cb);
      }], end);
      return;

    case 'personal_sign':
      var first = payload.params[0];
      var second = payload.params[1];

      var message, address;

      // We initially incorrectly ordered these parameters.
      // To gracefully respect users who adopted this API early,
      // we are currently gracefully recovering from the wrong param order
      // when it is clearly identifiable.
      //
      // That means when the first param is definitely an address,
      // and the second param is definitely not, but is hex.
      if (resemblesData(second) && resemblesAddress(first)) {
        var warning = 'The eth_personalSign method requires params ordered ';
        warning += '[message, address]. This was previously handled incorrectly, ';
        warning += 'and has been corrected automatically. ';
        warning += 'Please switch this param order for smooth behavior in the future.';
        console.warn(warning);

        address = payload.params[0];
        message = payload.params[1];
      } else {
        message = payload.params[0];
        address = payload.params[1];
      }

      // non-standard "extraParams" to be appended to our "msgParams" obj
      // good place for metadata
      var extraParams = payload.params[2] || {};
      var msgParams = extend(extraParams, {
        from: address,
        data: message
      });
      waterfall([function (cb) {
        return self.validatePersonalMessage(msgParams, cb);
      }, function (cb) {
        return self.processPersonalMessage(msgParams, cb);
      }], end);
      return;

    case 'personal_ecRecover':
      var message = payload.params[0];
      var signature = payload.params[1];
      // non-standard "extraParams" to be appended to our "msgParams" obj
      // good place for metadata
      var extraParams = payload.params[2] || {};
      var msgParams = extend(extraParams, {
        sig: signature,
        data: message
      });
      self.recoverPersonalSignature(msgParams, end);
      return;

    case 'eth_signTypedData':
      message = payload.params[0];
      address = payload.params[1];
      var extraParams = payload.params[2] || {};
      var msgParams = extend(extraParams, {
        from: address,
        data: message
      });
      waterfall([function (cb) {
        return self.validateTypedMessage(msgParams, cb);
      }, function (cb) {
        return self.processTypedMessage(msgParams, cb);
      }], end);
      return;

    default:
      next();
      return;

  }
};

//
// "process" high level flow
//

HookedWalletSubprovider.prototype.processTransaction = function (txParams, cb) {
  var self = this;
  waterfall([function (cb) {
    return self.approveTransaction(txParams, cb);
  }, function (didApprove, cb) {
    return self.checkApproval('transaction', didApprove, cb);
  }, function (cb) {
    return self.finalizeAndSubmitTx(txParams, cb);
  }], cb);
};

HookedWalletSubprovider.prototype.processSignTransaction = function (txParams, cb) {
  var self = this;
  waterfall([function (cb) {
    return self.approveTransaction(txParams, cb);
  }, function (didApprove, cb) {
    return self.checkApproval('transaction', didApprove, cb);
  }, function (cb) {
    return self.finalizeTx(txParams, cb);
  }], cb);
};

HookedWalletSubprovider.prototype.processMessage = function (msgParams, cb) {
  var self = this;
  waterfall([function (cb) {
    return self.approveMessage(msgParams, cb);
  }, function (didApprove, cb) {
    return self.checkApproval('message', didApprove, cb);
  }, function (cb) {
    return self.signMessage(msgParams, cb);
  }], cb);
};

HookedWalletSubprovider.prototype.processPersonalMessage = function (msgParams, cb) {
  var self = this;
  waterfall([function (cb) {
    return self.approvePersonalMessage(msgParams, cb);
  }, function (didApprove, cb) {
    return self.checkApproval('message', didApprove, cb);
  }, function (cb) {
    return self.signPersonalMessage(msgParams, cb);
  }], cb);
};

HookedWalletSubprovider.prototype.processTypedMessage = function (msgParams, cb) {
  var self = this;
  waterfall([function (cb) {
    return self.approveTypedMessage(msgParams, cb);
  }, function (didApprove, cb) {
    return self.checkApproval('message', didApprove, cb);
  }, function (cb) {
    return self.signTypedMessage(msgParams, cb);
  }], cb);
};

//
// approval
//

HookedWalletSubprovider.prototype.autoApprove = function (txParams, cb) {
  cb(null, true);
};

HookedWalletSubprovider.prototype.checkApproval = function (type, didApprove, cb) {
  cb(didApprove ? null : new Error('User denied ' + type + ' signature.'));
};

//
// signature and recovery
//

HookedWalletSubprovider.prototype.signTransaction = function (tx, cb) {
  cb(new Error('ProviderEngine - HookedWalletSubprovider - Must provide "signTransaction" fn in constructor options'));
};
HookedWalletSubprovider.prototype.signMessage = function (msgParams, cb) {
  cb(new Error('ProviderEngine - HookedWalletSubprovider - Must provide "signMessage" fn in constructor options'));
};
HookedWalletSubprovider.prototype.signPersonalMessage = function (msgParams, cb) {
  cb(new Error('ProviderEngine - HookedWalletSubprovider - Must provide "signPersonalMessage" fn in constructor options'));
};
HookedWalletSubprovider.prototype.signTypedMessage = function (msgParams, cb) {
  cb(new Error('ProviderEngine - HookedWalletSubprovider - Must provide "signTypedMessage" fn in constructor options'));
};

HookedWalletSubprovider.prototype.recoverPersonalSignature = function (msgParams, cb) {
  var senderHex = void 0;
  try {
    senderHex = sigUtil.recoverPersonalSignature(msgParams);
  } catch (err) {
    return cb(err);
  }
  cb(null, senderHex);
};

//
// validation
//

HookedWalletSubprovider.prototype.validateTransaction = function (txParams, cb) {
  var self = this;
  // shortcut: undefined sender is invalid
  if (txParams.from === undefined) return cb(new Error('Undefined address - from address required to sign transaction.'));
  self.validateSender(txParams.from, function (err, senderIsValid) {
    if (err) return cb(err);
    if (!senderIsValid) return cb(new Error('Unknown address - unable to sign transaction for this address: "' + txParams.from + '"'));
    cb();
  });
};

HookedWalletSubprovider.prototype.validateMessage = function (msgParams, cb) {
  var self = this;
  if (msgParams.from === undefined) return cb(new Error('Undefined address - from address required to sign message.'));
  self.validateSender(msgParams.from, function (err, senderIsValid) {
    if (err) return cb(err);
    if (!senderIsValid) return cb(new Error('Unknown address - unable to sign message for this address: "' + msgParams.from + '"'));
    cb();
  });
};

HookedWalletSubprovider.prototype.validatePersonalMessage = function (msgParams, cb) {
  var self = this;
  if (msgParams.from === undefined) return cb(new Error('Undefined address - from address required to sign personal message.'));
  if (msgParams.data === undefined) return cb(new Error('Undefined message - message required to sign personal message.'));
  if (!isValidHex(msgParams.data)) return cb(new Error('HookedWalletSubprovider - validateMessage - message was not encoded as hex.'));
  self.validateSender(msgParams.from, function (err, senderIsValid) {
    if (err) return cb(err);
    if (!senderIsValid) return cb(new Error('Unknown address - unable to sign message for this address: "' + msgParams.from + '"'));
    cb();
  });
};

HookedWalletSubprovider.prototype.validateTypedMessage = function (msgParams, cb) {
  if (msgParams.from === undefined) return cb(new Error('Undefined address - from address required to sign typed data.'));
  if (msgParams.data === undefined) return cb(new Error('Undefined data - message required to sign typed data.'));
  this.validateSender(msgParams.from, function (err, senderIsValid) {
    if (err) return cb(err);
    if (!senderIsValid) return cb(new Error('Unknown address - unable to sign message for this address: "' + msgParams.from + '"'));
    cb();
  });
};

HookedWalletSubprovider.prototype.validateSender = function (senderAddress, cb) {
  var self = this;
  // shortcut: undefined sender is invalid
  if (!senderAddress) return cb(null, false);
  self.getAccounts(function (err, accounts) {
    if (err) return cb(err);
    var senderIsValid = accounts.map(toLowerCase).indexOf(senderAddress.toLowerCase()) !== -1;
    cb(null, senderIsValid);
  });
};

//
// tx helpers
//

HookedWalletSubprovider.prototype.finalizeAndSubmitTx = function (txParams, cb) {
  var self = this;
  // can only allow one tx to pass through this flow at a time
  // so we can atomically consume a nonce
  self.nonceLock.take(function () {
    waterfall([self.fillInTxExtras.bind(self, txParams), self.signTransaction.bind(self), self.publishTransaction.bind(self)], function (err, txHash) {
      self.nonceLock.leave();
      if (err) return cb(err);
      cb(null, txHash);
    });
  });
};

HookedWalletSubprovider.prototype.finalizeTx = function (txParams, cb) {
  var self = this;
  // can only allow one tx to pass through this flow at a time
  // so we can atomically consume a nonce
  self.nonceLock.take(function () {
    waterfall([self.fillInTxExtras.bind(self, txParams), self.signTransaction.bind(self)], function (err, signedTx) {
      self.nonceLock.leave();
      if (err) return cb(err);
      cb(null, { raw: signedTx, tx: txParams });
    });
  });
};

HookedWalletSubprovider.prototype.publishTransaction = function (rawTx, cb) {
  var self = this;
  self.emitPayload({
    method: 'eth_sendRawTransaction',
    params: [rawTx]
  }, function (err, res) {
    if (err) return cb(err);
    cb(null, res.result);
  });
};

HookedWalletSubprovider.prototype.fillInTxExtras = function (txParams, cb) {
  var self = this;
  var address = txParams.from;
  // console.log('fillInTxExtras - address:', address)

  var reqs = {};

  if (txParams.gasPrice === undefined) {
    // console.log("need to get gasprice")
    reqs.gasPrice = self.emitPayload.bind(self, { method: 'eth_gasPrice', params: [] });
  }

  if (txParams.nonce === undefined) {
    // console.log("need to get nonce")
    reqs.nonce = self.emitPayload.bind(self, { method: 'eth_getTransactionCount', params: [address, 'pending'] });
  }

  if (txParams.gas === undefined) {
    // console.log("need to get gas")
    reqs.gas = estimateGas.bind(null, self.engine, cloneTxParams(txParams));
  }

  parallel(reqs, function (err, result) {
    if (err) return cb(err);
    // console.log('fillInTxExtras - result:', result)

    var res = {};
    if (result.gasPrice) res.gasPrice = result.gasPrice.result;
    if (result.nonce) res.nonce = result.nonce.result;
    if (result.gas) res.gas = result.gas;

    cb(null, extend(res, txParams));
  });
};

// util

// we use this to clean any custom params from the txParams
function cloneTxParams(txParams) {
  return {
    from: txParams.from,
    to: txParams.to,
    value: txParams.value,
    data: txParams.data,
    gas: txParams.gas,
    gasPrice: txParams.gasPrice,
    nonce: txParams.nonce
  };
}

function toLowerCase(string) {
  return string.toLowerCase();
}

function resemblesAddress(string) {
  var fixed = ethUtil.addHexPrefix(string);
  var isValid = ethUtil.isValidAddress(fixed);
  return isValid;
}

// Returns true if resembles hex data
// but definitely not a valid address.
function resemblesData(string) {
  var fixed = ethUtil.addHexPrefix(string);
  var isValidAddress = ethUtil.isValidAddress(fixed);
  return !isValidAddress && isValidHex(string);
}

function isValidHex(data) {
  var isString = typeof data === 'string';
  if (!isString) return false;
  var isHexPrefixed = data.slice(0, 2) === '0x';
  if (!isHexPrefixed) return false;
  var nonPrefixed = data.slice(2);
  var isValid = nonPrefixed.match(hexRegex);
  return isValid;
}