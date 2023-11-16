// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditLine} from "./interfaces/ICreditLine.sol";
import {BorrowerLevelCreditConfig} from "./BorrowerLevelCreditConfig.sol";
import {CreditConfig, CreditRecord} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

import "hardhat/console.sol";

/**
 * Credit Line is one of the most common forms of credit on Huma.
 * The borrower can drawdown and payback repeatedly against a pre-approved
 * credit line as long as they stay under the approved credit limit.
 */
contract CreditLine is BorrowerLevelCreditConfig, ICreditLine {
    /// @inheritdoc ICreditLine
    function drawdown(address borrower, uint256 borrowAmount) external virtual override {
        poolConfig.onlyProtocolAndPoolOn();
        if (borrower != msg.sender) revert Errors.notBorrower();
        if (borrowAmount == 0) revert Errors.zeroAmountProvided();

        bytes32 creditHash = getCreditHash(borrower);
        if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();
        _drawdown(borrower, creditHash, borrowAmount);
    }

    /// @inheritdoc ICreditLine
    function makePayment(
        address borrower,
        uint256 amount
    ) external virtual override returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        // TODO: do we still need the PDS service account to make payment?
        if (msg.sender != borrower) _onlyPDSServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();

        (amountPaid, paidoff, ) = _makePayment(borrower, creditHash, amount);
        return (amountPaid, paidoff);
    }

    /// @inheritdoc ICreditLine
    function makePrincipalPayment(
        address borrower,
        uint256 amount
    ) external virtual override returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        // TODO: Remove the following condition since we want to allow non-borrowers to make payment
        // on the behalf of the borrower (mostly intended for invoice issuers).
        if (msg.sender != borrower) _onlyPDSServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();

        (amountPaid, paidoff) = _makePrincipalPayment(borrower, creditHash, amount);
        return (amountPaid, paidoff);
    }
}
