// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

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
        uint256 borrowAmount
    ) external virtual override returns (uint256 netAmountToBorrower) {
        poolConfig.onlyProtocolAndPoolOn();

        bytes32 creditHash = getCreditHash(msg.sender);
        creditManager.onlyCreditBorrower(creditHash, msg.sender);
        return _drawdown(msg.sender, creditHash, borrowAmount);
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

        return _makePayment(borrower, creditHash, amount);
    }

    /// @inheritdoc ICreditLine
    function makePrincipalPayment(
        uint256 amount
    ) external virtual override returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();

        bytes32 creditHash = getCreditHash(msg.sender);
        creditManager.onlyCreditBorrower(creditHash, msg.sender);

        (amountPaid, paidoff) = _makePrincipalPayment(msg.sender, creditHash, amount);
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

    function getCreditHash(address borrower) public view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), borrower));
    }
}
