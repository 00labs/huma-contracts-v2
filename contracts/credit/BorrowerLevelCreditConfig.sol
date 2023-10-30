// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IBorrowerLevelCreditConfig} from "./interfaces/IBorrowerLevelCreditConfig.sol";
import {Credit} from "./Credit.sol";
import {CreditConfig, CreditRecord, DueDetail} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

import "hardhat/console.sol";

/**
 * BorrowerLevelCreditConfig has a set of administrative functions to manage the settings
 * for a borrower-level credit. A borrower-level credit can have many drawdowns and paybacks
 * with or without backing of a collateral or receivable, but the balance is all aggregated
 * at the borrower-level. A classic example of borrower-level credit is credit line.
 */
abstract contract BorrowerLevelCreditConfig is Credit, IBorrowerLevelCreditConfig {
    event LateFeeWaived(address borrower, uint256 amountWaived);

    //* todo standardie whether to emit events at Credit contract or this contract.
    //* todo standardie where to place access control, at Credit contract or this contract

    /// @inheritdoc IBorrowerLevelCreditConfig
    function refreshCredit(address borrower) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _refreshCredit(creditHash);
    }

    /// @inheritdoc IBorrowerLevelCreditConfig
    function triggerDefault(address borrower) external virtual override returns (uint256 losses) {
        bytes32 creditHash = getCreditHash(borrower);
        _triggerDefault(creditHash);
    }

    /// @inheritdoc IBorrowerLevelCreditConfig
    function closeCredit(address borrower) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _closeCredit(creditHash);
    }

    /// @inheritdoc IBorrowerLevelCreditConfig
    function pauseCredit(address borrower) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _pauseCredit(creditHash);
    }

    /// @inheritdoc IBorrowerLevelCreditConfig
    function unpauseCredit(address borrower) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _unpauseCredit(creditHash);
    }

    /// @inheritdoc IBorrowerLevelCreditConfig
    function updateYield(address borrower, uint256 yieldInBps) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _updateYield(creditHash, yieldInBps);
    }

    function getCreditHash(address borrower) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), borrower));
    }

    /// @inheritdoc IBorrowerLevelCreditConfig
    function extendRemainingPeriod(
        address borrower,
        uint256 numOfPeriods
    ) external virtual override {
        _onlyEAServiceAccount();
        bytes32 creditHash = getCreditHash(borrower);
        _extendRemainingPeriod(creditHash, numOfPeriods);
    }

    /// @inheritdoc IBorrowerLevelCreditConfig
    function updateLimitAndCommitment(
        address borrower,
        uint256 creditLimit,
        uint256 committedAmount
    ) external virtual override {
        _onlyEAServiceAccount();
        if (committedAmount > creditLimit) revert Errors.todo();

        _updateLimitAndCommitment(getCreditHash(borrower), creditLimit, committedAmount);
    }

    /// @inheritdoc IBorrowerLevelCreditConfig
    function waiveLateFee(address borrower, uint256 amount) external {
        _onlyEAServiceAccount();
        uint256 amountWaived = _waiveLateFee(getCreditHash(borrower), amount);
        emit LateFeeWaived(borrower, amountWaived);
    }
}
