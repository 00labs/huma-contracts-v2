// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditLine} from "./interfaces/ICreditLine.sol";
import {Credit} from "./Credit.sol";
import {CreditRecord, DueDetail} from "./CreditStructs.sol";
import {Errors} from "../common/Errors.sol";

/**
 * @notice Credit Line is one of the most common forms of credit on Huma.
 * The borrower can drawdown and payback repeatedly against a pre-approved
 * credit line as long as they stay under the approved credit limit.
 */
contract CreditLine is Credit, ICreditLine {
    /// @inheritdoc ICreditLine
    function drawdown(
        address borrower,
        uint256 borrowAmount
    ) external virtual override returns (uint256 netAmountToBorrower) {
        poolConfig.onlyProtocolAndPoolOn();
        if (borrower != msg.sender) revert Errors.BorrowerRequired();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);
        return _drawdown(borrower, creditHash, borrowAmount);
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
    }

    /// @inheritdoc ICreditLine
    function makePrincipalPayment(
        address borrower,
        uint256 amount
    ) external virtual override returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) _onlySentinelServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        (amountPaid, paidoff) = _makePrincipalPayment(borrower, creditHash, amount);
    }

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

    function getCreditHash(address borrower) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), borrower));
    }
}
