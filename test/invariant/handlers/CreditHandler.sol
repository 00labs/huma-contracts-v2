// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseHandler} from "./BaseHandler.sol";
import {CreditDueManager} from "contracts/credit/CreditDueManager.sol";

abstract contract CreditHandler is BaseHandler {
    uint256 immutable minDrawdownAmount;
    uint256 immutable minPaymentAmount;

    CreditDueManager creditDueManager;

    address[] borrowers;
    address[] borrowedBorrowers;

    constructor(address[] memory _borrowers) BaseHandler() {
        creditDueManager = CreditDueManager(poolConfig.creditDueManager());
        borrowers = _borrowers;

        minDrawdownAmount = _toToken(100000);
        minPaymentAmount = _toToken(1000);
    }
}
