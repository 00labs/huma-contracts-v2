// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditLine} from "./interfaces/ICreditLine.sol";
import {Credit} from "./Credit.sol";
import {CreditRecord, DueDetail} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

import "hardhat/console.sol";

/**
 * Credit Line is one of the most common forms of credit on Huma.
 * The borrower can drawdown and payback repeatedly against a pre-approved
 * credit line as long as they stay under the approved credit limit.
 */
contract CreditLine is Credit, ICreditLine {
    /// @inheritdoc ICreditLine
    function getNextBillRefreshDate(address borrower) external view returns (uint256 refreshDate) {
        bytes32 creditHash = getCreditHash(borrower);
        return _getNextBillRefreshDate(creditHash);
    }

    /// @inheritdoc ICreditLine
    function getDueInfo(
        address borrower
    ) external view returns (CreditRecord memory cr, DueDetail memory dd) {
        bytes32 creditHash = getCreditHash(borrower);
        return _getDueInfo(creditHash);
    }

    /// @inheritdoc ICreditLine
    function drawdown(address borrower, uint256 borrowAmount) external virtual override {
        poolConfig.onlyProtocolAndPoolOn();
        if (borrower != msg.sender) revert Errors.notBorrower();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);
        _drawdown(borrower, creditHash, borrowAmount);
    }

    /// @inheritdoc ICreditLine
    function makePayment(
        address borrower,
        uint256 amount
    ) external virtual override returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) _onlySentinelServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);

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
        if (msg.sender != borrower) _onlySentinelServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        (amountPaid, paidoff) = _makePrincipalPayment(borrower, creditHash, amount);
        return (amountPaid, paidoff);
    }

    function getCreditHash(address borrower) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), borrower));
    }
}
