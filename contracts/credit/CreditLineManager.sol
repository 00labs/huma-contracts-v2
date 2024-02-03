// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {ICreditLineManager} from "./interfaces/ICreditLineManager.sol";
import {CreditManager} from "./CreditManager.sol";
import {PayPeriodDuration} from "../common/SharedDefs.sol";
import {Errors} from "../common/Errors.sol";

/**
 * @notice CreditLineManager has a set of administrative functions to manage the settings
 * for a borrower-level credit. A borrower-level credit can have many drawdowns and paybacks
 * with or without backing of a collateral or receivable, but the balance is all aggregated
 * at the borrower-level. A classic example of borrower-level credit is credit line.
 */
contract CreditLineManager is CreditManager, ICreditLineManager {
    /**
     * @notice A credit line has been approved.
     * @param borrower The address of the borrower.
     * @param creditHash The hash of the credit.
     * @param creditLimit The maximum amount that can be borrowed.
     * @param periodDuration The duration of each pay period, e.g. monthly, quarterly or semi-annually.
     * @param remainingPeriods The number of periods before the credit expires.
     * @param yieldInBps The expected yield expressed in basis points, 1% is 100, 100% is 10000.
     * @param committedAmount The amount that the borrower has committed to use. If the used credit
     * is less than this amount, the borrower will be charged yield using this amount.
     * @param revolving A flag indicating if the repeated borrowing is allowed.
     */
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

    /// @inheritdoc ICreditLineManager
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

    /// @inheritdoc ICreditLineManager
    function startCommittedCredit(address borrower) external virtual override {
        poolConfig.onlyProtocolAndPoolOn();
        poolConfig.onlyPoolOwnerOrSentinelServiceAccount(msg.sender);

        bytes32 creditHash = getCreditHash(borrower);
        onlyCreditBorrower(creditHash, borrower);
        _startCommittedCredit(creditHash);
    }

    /// @inheritdoc ICreditLineManager
    function refreshCredit(address borrower) external virtual override {
        poolConfig.onlyProtocolAndPoolOn();

        bytes32 creditHash = getCreditHash(borrower);
        _refreshCredit(creditHash);
    }

    /// @inheritdoc ICreditLineManager
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
        return _triggerDefault(creditHash);
    }

    /// @inheritdoc ICreditLineManager
    function closeCredit(address borrower) external virtual override {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower && msg.sender != humaConfig.eaServiceAccount())
            revert Errors.BorrowerOrEARequired();

        bytes32 creditHash = getCreditHash(borrower);
        onlyCreditBorrower(creditHash, borrower);
        _closeCredit(creditHash);
    }

    /// @inheritdoc ICreditLineManager
    function updateYield(address borrower, uint256 yieldInBps) external virtual override {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        _updateYield(creditHash, yieldInBps);
    }

    /// @inheritdoc ICreditLineManager
    function extendRemainingPeriod(
        address borrower,
        uint256 numOfPeriods
    ) external virtual override {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        _extendRemainingPeriod(creditHash, numOfPeriods);
    }

    /// @inheritdoc ICreditLineManager
    function updateLimitAndCommitment(
        address borrower,
        uint256 creditLimit,
        uint256 committedAmount
    ) external virtual override {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();
        if (committedAmount > creditLimit) revert Errors.CommittedAmountGreaterThanCreditLimit();

        _updateLimitAndCommitment(getCreditHash(borrower), creditLimit, committedAmount);
    }

    /// @inheritdoc ICreditLineManager
    function waiveLateFee(address borrower, uint256 amount) external {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        _waiveLateFee(getCreditHash(borrower), amount);
    }

    function getCreditHash(address borrower) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(credit), borrower));
    }
}
