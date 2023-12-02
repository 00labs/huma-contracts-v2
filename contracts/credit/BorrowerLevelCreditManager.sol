// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IBorrowerLevelCreditManager} from "./interfaces/IBorrowerLevelCreditManager.sol";
import {CreditManager} from "./CreditManager.sol";
import {CreditConfig, CreditRecord, DueDetail, PayPeriodDuration, CreditLineClosureReason} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

/**
 * BorrowerLevelCreditConfig has a set of administrative functions to manage the settings
 * for a borrower-level credit. A borrower-level credit can have many drawdowns and paybacks
 * with or without backing of a collateral or receivable, but the balance is all aggregated
 * at the borrower-level. A classic example of borrower-level credit is credit line.
 */
contract BorrowerLevelCreditManager is CreditManager, IBorrowerLevelCreditManager {
    //* todo standardize whether to emit events at Credit contract or this contract.
    //* todo standardize where to place access control, at Credit contract or this contract

    /**
     * @notice An existing credit line has been closed
     * @param reasonCode the reason for the credit line closure
     */
    event CreditLineClosed(
        address indexed borrower,
        address by,
        CreditLineClosureReason reasonCode
    );

    event LateFeeWaived(address borrower, uint256 amountWaived);

    event CreditLineApproved(
        address indexed borrower,
        bytes32 indexed creditHash,
        uint256 creditLimit,
        PayPeriodDuration periodDuration,
        uint256 remainingPeriods,
        uint256 yieldInBps,
        uint256 committedAmount,
        bool revolving
    );

    /// @inheritdoc IBorrowerLevelCreditManager
    function approveBorrower(
        address borrower,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount,
        uint64 designatedStartDate,
        bool revolving
    ) external virtual override {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        _approveCredit(
            borrower,
            creditHash,
            creditLimit,
            remainingPeriods,
            yieldInBps,
            committedAmount,
            designatedStartDate,
            revolving
        );

        emit CreditLineApproved(
            borrower,
            creditHash,
            creditLimit,
            getCreditConfig(creditHash).periodDuration,
            remainingPeriods,
            yieldInBps,
            committedAmount,
            revolving
        );
    }

    /// @inheritdoc IBorrowerLevelCreditManager
    function startCommittedCredit(address borrower) external virtual override {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyPDSServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        onlyCreditBorrower(creditHash, borrower);
        _startCommittedCredit(borrower, creditHash);
    }

    /// @inheritdoc IBorrowerLevelCreditManager
    function refreshCredit(address borrower) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _refreshCredit(creditHash);
    }

    /// @inheritdoc IBorrowerLevelCreditManager
    function triggerDefault(
        address borrower
    )
        external
        virtual
        override
        returns (uint256 principalLoss, uint256 yieldLoss, uint256 feesLoss)
    {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();
        bytes32 creditHash = getCreditHash(borrower);
        return _triggerLiquidation(creditHash);
    }

    /// @inheritdoc IBorrowerLevelCreditManager
    /// @dev Only the borrower or EA Service account can call this function
    function closeCredit(address borrower) external virtual override {
        if (msg.sender != borrower && msg.sender != humaConfig.eaServiceAccount())
            revert Errors.notBorrowerOrEA();
        bytes32 creditHash = getCreditHash(borrower);
        onlyCreditBorrower(creditHash, borrower);
        _closeCredit(creditHash);
        emit CreditLineClosed(borrower, msg.sender, CreditLineClosureReason.AdminClosure);
    }

    /// @inheritdoc IBorrowerLevelCreditManager
    function pauseCredit(address borrower) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _pauseCredit(creditHash);
    }

    /// @inheritdoc IBorrowerLevelCreditManager
    function unpauseCredit(address borrower) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _unpauseCredit(creditHash);
    }

    /// @inheritdoc IBorrowerLevelCreditManager
    function updateYield(address borrower, uint256 yieldInBps) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _updateYield(creditHash, yieldInBps);
    }

    function getCreditHash(address borrower) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(credit), borrower));
    }

    /// @inheritdoc IBorrowerLevelCreditManager
    function extendRemainingPeriod(
        address borrower,
        uint256 numOfPeriods
    ) external virtual override {
        _onlyEAServiceAccount();
        bytes32 creditHash = getCreditHash(borrower);
        _extendRemainingPeriod(creditHash, numOfPeriods);
    }

    /// @inheritdoc IBorrowerLevelCreditManager
    function updateLimitAndCommitment(
        address borrower,
        uint256 creditLimit,
        uint256 committedAmount
    ) external virtual override {
        _onlyEAServiceAccount();
        if (committedAmount > creditLimit) revert Errors.committedAmountGreaterThanCreditLimit();

        _updateLimitAndCommitment(getCreditHash(borrower), creditLimit, committedAmount);
    }

    /// @inheritdoc IBorrowerLevelCreditManager
    function waiveLateFee(address borrower, uint256 amount) external {
        _onlyEAServiceAccount();
        uint256 amountWaived = _waiveLateFee(getCreditHash(borrower), amount);
        emit LateFeeWaived(borrower, amountWaived);
    }
}
