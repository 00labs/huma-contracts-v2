// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {HumaConfig} from "../common/HumaConfig.sol";
import {ICredit} from "./interfaces/ICredit.sol";
import {ICalendar} from "../common/interfaces/ICalendar.sol";
import {IPool} from "../liquidity/interfaces/IPool.sol";
import {ICreditManager} from "./interfaces/ICreditManager.sol";
import {PoolConfig, PoolSettings} from "../common/PoolConfig.sol";
import {PoolConfigCache} from "../common/PoolConfigCache.sol";
import {CreditManagerStorage} from "./CreditManagerStorage.sol";
import {CreditClosureReason, CreditConfig, CreditRecord, CreditState, DueDetail} from "./CreditStructs.sol";
import {PayPeriodDuration} from "../common/SharedDefs.sol";
import {Errors} from "../common/Errors.sol";
import {ICreditDueManager} from "./interfaces/ICreditDueManager.sol";

abstract contract CreditManager is PoolConfigCache, CreditManagerStorage, ICreditManager {
    /**
     * @notice A credit with a committed amount has started.
     * @param creditHash The hash of the credit.
     */
    event CommittedCreditStarted(bytes32 indexed creditHash);

    /**
     * @notice An existing credit has been closed.
     * @param creditHash The hash of the credit.
     * @param reasonCode The reason for the credit closure.
     * @param by The address who closed the credit.
     */
    event CreditClosed(bytes32 indexed creditHash, CreditClosureReason reasonCode, address by);

    /**
     * @notice The credit has been marked as Defaulted.
     * @param creditHash The hash of the credit.
     * @param principalLoss The principal losses to be written off because of the default.
     * @param yieldLoss The unpaid yield due to be written off.
     * @param feesLoss The unpaid fees to be written off.
     * @param by The address who triggered the default.
     */
    event DefaultTriggered(
        bytes32 indexed creditHash,
        uint256 principalLoss,
        uint256 yieldLoss,
        uint256 feesLoss,
        address by
    );

    /**
     * @notice The expiration (maturity) date of a credit has been extended.
     * @param creditHash The hash of the credit.
     * @param oldRemainingPeriods The number of remaining pay periods before the extension.
     * @param newRemainingPeriods The number of remaining pay periods after the extension.
     * @param by The address who has triggered the update.
     */
    event RemainingPeriodsExtended(
        bytes32 indexed creditHash,
        uint256 oldRemainingPeriods,
        uint256 newRemainingPeriods,
        address by
    );

    /**
     * @notice The yield of a credit has been updated.
     * @param creditHash The credit hash.
     * @param oldYieldInBps The old yield in basis points before the update.
     * @param newYieldInBps The new yield in basis points limit after the update.
     * @param oldYieldDue The old amount of yield due before the update.
     * @param newYieldDue The new amount of yield due after the update.
     * @param by The address who triggered the update.
     */
    event YieldUpdated(
        bytes32 indexed creditHash,
        uint256 oldYieldInBps,
        uint256 newYieldInBps,
        uint256 oldYieldDue,
        uint256 newYieldDue,
        address by
    );

    /**
     * @notice The credit limit and committed amount of a credit have been updated.
     * @param creditHash The credit hash.
     * @param oldLimit The old credit limit before the update.
     * @param newLimit The new credit limit after the update.
     * @param oldCommittedAmount The old committed amount before the update.
     * @param newCommittedAmount The new committed amount after the update.
     * @param oldYieldDue The old amount of yield due before the update.
     * @param newYieldDue The new amount of yield due after the update.
     * @param by The address who triggered the update.
     */
    event LimitAndCommitmentUpdated(
        bytes32 indexed creditHash,
        uint256 oldLimit,
        uint256 newLimit,
        uint256 oldCommittedAmount,
        uint256 newCommittedAmount,
        uint256 oldYieldDue,
        uint256 newYieldDue,
        address by
    );

    /**
     * @notice Part or all of the late fee due of a credit has been waived.
     * @param creditHash The credit hash.
     * @param oldLateFee The amount of late fee before the update.
     * @param newLateFee The amount of late fee after the update.
     * @param by The address who triggered the update.
     */
    event LateFeeWaived(
        bytes32 indexed creditHash,
        uint256 oldLateFee,
        uint256 newLateFee,
        address by
    );

    /// @inheritdoc ICreditManager
    function getCreditBorrower(bytes32 creditHash) external view returns (address) {
        return _creditBorrowerMap[creditHash];
    }

    /**
     * @notice Checks if the credit is ready to be triggered as defaulted.
     * @param creditHash The credit hash.
     * @return isReady A boolean flag for ready for default or not.
     */
    function isDefaultReady(bytes32 creditHash) public view virtual returns (bool isReady) {
        CreditConfig memory cc = getCreditConfig(creditHash);
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        (cr, ) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
        return _isDefaultReady(cc.periodDuration, cr.missedPeriods);
    }

    /// @inheritdoc ICreditManager
    function getCreditConfig(bytes32 creditHash) public view returns (CreditConfig memory) {
        return _creditConfigMap[creditHash];
    }

    /// @inheritdoc ICreditManager
    function onlyCreditBorrower(bytes32 creditHash, address borrower) public view {
        if (borrower != _creditBorrowerMap[creditHash]) revert Errors.BorrowerRequired();
    }

    /**
     * @notice Pulls the addresses of dependent contracts from poolConfig and caches them.
     */
    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = address(_poolConfig.humaConfig());
        assert(addr != address(0));
        humaConfig = HumaConfig(addr);

        addr = _poolConfig.calendar();
        assert(addr != address(0));
        calendar = ICalendar(addr);

        addr = _poolConfig.credit();
        assert(addr != address(0));
        credit = ICredit(addr);

        addr = _poolConfig.creditDueManager();
        assert(addr != address(0));
        dueManager = ICreditDueManager(addr);
    }

    /**
     * @notice Approves a credit with the specified terms.
     * @param borrower The borrower of the credit.
     * @param creditHash The hash of the credit.
     * @param creditLimit The credit limit.
     * @param remainingPeriods The number of periods until maturity.
     * @param yieldInBps The yield of the credit measured in basis points.
     * @param committedAmount The committed amount, i.e., if the borrower does not borrow up to
     * this amount, this amount will be used in yield calculation.
     * @param designatedStartDate The required start date of the credit.
     * @param revolving If the credit is revolving or not.
     */
    function _approveCredit(
        address borrower,
        bytes32 creditHash,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount,
        uint64 designatedStartDate,
        bool revolving
    ) internal virtual {
        // It's only theoretically possible for the hash value to be 0, so using an assert here instead of
        // revert.
        assert(creditHash != bytes32(0));

        if (borrower == address(0)) revert Errors.ZeroAddressProvided();
        if (creditLimit == 0) revert Errors.ZeroAmountProvided();
        if (remainingPeriods == 0) revert Errors.ZeroPayPeriods();
        if (committedAmount > creditLimit) revert Errors.CommittedAmountGreaterThanCreditLimit();
        // It doesn't make sense for a credit to have no commitment but a non-zero designated startt date.
        if (committedAmount == 0 && designatedStartDate != 0)
            revert Errors.CreditWithoutCommitmentShouldHaveNoDesignatedStartDate();
        if (designatedStartDate > 0 && block.timestamp > designatedStartDate)
            revert Errors.DesignatedStartDateInThePast();
        if (designatedStartDate > 0 && remainingPeriods <= 1) {
            // Business rule: do not allow credits with designated start date to have only 1 period.
            revert Errors.PayPeriodsTooLowForCreditsWithDesignatedStartDate();
        }

        PoolSettings memory ps = poolConfig.getPoolSettings();
        if (creditLimit > ps.maxCreditLine) {
            revert Errors.CreditLimitTooHigh();
        }

        // Before a drawdown happens, it is allowed to re-approve a credit to change the terms.
        // Once a drawdown has happened, it is disallowed to re-approve a credit. One has to call
        // other admin functions to change the terms of the credit.
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state != CreditState.Deleted && cr.state != CreditState.Approved)
            revert Errors.CreditNotInStateForUpdate();

        CreditConfig memory cc = getCreditConfig(creditHash);
        cc.creditLimit = creditLimit;
        cc.committedAmount = committedAmount;
        cc.periodDuration = ps.payPeriodDuration;
        cc.numOfPeriods = remainingPeriods;
        cc.yieldInBps = yieldInBps;
        cc.revolving = revolving;
        cc.advanceRateInBps = ps.advanceRateInBps;
        cc.receivableAutoApproval = ps.receivableAutoApproval;
        _setCreditConfig(creditHash, cc);

        // Note: Special logic. dueDate is normally used to track the next bill due.
        // Before the first drawdown, it is also used to set the designated start date
        // when the drawdown should happen.
        // Note that a zero designated start date means the credit start date will be determined
        // solely on first drawdown, in which case `cr.nextDueDate` should also be 0, hence
        // the following assignment always work.
        cr.nextDueDate = designatedStartDate;
        cr.remainingPeriods = remainingPeriods;
        cr.state = CreditState.Approved;
        credit.setCreditRecord(creditHash, cr);

        _creditBorrowerMap[creditHash] = borrower;
    }

    /**
     * @notice Helper function for `startCommittedCredit`.
     * @param creditHash The hash of the credit.
     * @custom:access Internal function, access control is done outside of this function.
     */
    function _startCommittedCredit(bytes32 creditHash) internal virtual {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (
            cr.state != CreditState.Approved ||
            cr.nextDueDate == 0 ||
            block.timestamp < cr.nextDueDate
        ) {
            // A credit with commitment cannot be started if any of the following conditions are true:
            // 1. A credit is not yet approved, or has already begun.
            // 2. The due date is 0, meaning the credit has no designated start date.
            // 3. We have not yet reached the designated start date.
            revert Errors.CommittedCreditCannotBeStarted();
        }
        CreditConfig memory cc = getCreditConfig(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        (cr, dd) = dueManager.getDueInfo(cr, cc, dd, cr.nextDueDate);
        credit.updateDueInfo(creditHash, cr, dd);

        emit CommittedCreditStarted(creditHash);
    }

    /**
     * @notice Closes a credit record.
     * @param creditHash The hash of the credit.
     * @custom:access The calling function is responsible for access control
     */
    function _closeCredit(bytes32 creditHash) internal virtual {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.nextDue != 0 || cr.totalPastDue != 0 || cr.unbilledPrincipal != 0) {
            revert Errors.CreditHasOutstandingBalance();
        }

        CreditConfig memory cc = getCreditConfig(creditHash);
        if (cr.state != CreditState.Approved && cc.committedAmount > 0 && cr.remainingPeriods > 0)
            // If a credit has started and has unfulfilled commitment, then don't allow it to be closed.
            revert Errors.CreditHasUnfulfilledCommitment();

        cc.creditLimit = 0;
        _setCreditConfig(creditHash, cc);

        // Close the credit by removing relevant record.
        cr.state = CreditState.Deleted;
        cr.remainingPeriods = 0;
        credit.setCreditRecord(creditHash, cr);

        emit CreditClosed(creditHash, CreditClosureReason.AdminClosure, msg.sender);
    }

    /**
     * @notice Updates the account and brings its billing status current
     * @param creditHash The hash of the credit.
     */
    function _refreshCredit(bytes32 creditHash) internal {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.GoodStanding || cr.state == CreditState.Delayed) {
            // Only refresh the bill when it's in GoodStanding and Delayed. The bill should
            // stay as-is in all other states.
            CreditConfig memory cc = getCreditConfig(creditHash);
            DueDetail memory dd = credit.getDueDetail(creditHash);
            (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
            credit.updateDueInfo(creditHash, cr, dd);
        }
    }

    /**
     * @notice Triggers the default process.
     * @param creditHash The hash of the credit.
     * @return principalLoss The amount of principal that is written off
     * @return yieldLoss The unpaid yield due that is written off
     * @return feesLoss The unpaid fees that are written off
     * @dev It is possible for the borrower to payback even after default, especially in
     * receivable factoring cases.
     */
    function _triggerDefault(
        bytes32 creditHash
    ) internal virtual returns (uint256 principalLoss, uint256 yieldLoss, uint256 feesLoss) {
        // check to make sure the default grace period has passed.
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.Defaulted) revert Errors.DefaultHasAlreadyBeenTriggered();

        CreditConfig memory cc = getCreditConfig(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);

        // Check if grace period has been exceeded.
        if (!_isDefaultReady(cc.periodDuration, cr.missedPeriods))
            revert Errors.DefaultTriggeredTooEarly();

        principalLoss = cr.unbilledPrincipal + cr.nextDue - cr.yieldDue + dd.principalPastDue;
        yieldLoss = cr.yieldDue + dd.yieldPastDue;
        feesLoss = dd.lateFee;

        IPool(poolConfig.pool()).distributeProfit(yieldLoss + feesLoss);
        IPool(poolConfig.pool()).distributeLoss(principalLoss + yieldLoss + feesLoss);

        cr.state = CreditState.Defaulted;
        credit.updateDueInfo(creditHash, cr, dd);
        emit DefaultTriggered(creditHash, principalLoss, yieldLoss, feesLoss, msg.sender);
    }

    /**
     * @notice Extends the expiration (maturity) date of a credit.
     * @param creditHash The hash of the credit.
     * @param extraNumOfPeriods The number of pay periods to be extended.
     */
    function _extendRemainingPeriod(
        bytes32 creditHash,
        uint256 extraNumOfPeriods
    ) internal virtual {
        // Although not essential to call getDueInfo() to extend the credit duration,
        // it is still a good practice to bring the account current while we update one of the fields.
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state != CreditState.GoodStanding) {
            revert Errors.CreditNotInStateForUpdate();
        }
        CreditConfig memory cc = getCreditConfig(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
        if (cr.state != CreditState.GoodStanding) {
            revert Errors.CreditNotInStateForUpdate();
        }

        cc.numOfPeriods += uint16(extraNumOfPeriods);
        _setCreditConfig(creditHash, cc);

        uint256 oldRemainingPeriods = cr.remainingPeriods;
        cr.remainingPeriods += uint16(extraNumOfPeriods);
        credit.updateDueInfo(creditHash, cr, dd);

        emit RemainingPeriodsExtended(
            creditHash,
            oldRemainingPeriods,
            cr.remainingPeriods,
            msg.sender
        );
    }

    /**
     * @notice Updates the yield of the credit.
     * @param creditHash The hash of the credit.
     * @param yieldInBps the new yield in basis points.
     */
    function _updateYield(bytes32 creditHash, uint256 yieldInBps) internal virtual {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.Approved || cr.state == CreditState.Deleted) {
            revert Errors.CreditNotInStateForUpdate();
        }
        CreditConfig memory cc = getCreditConfig(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
        // No state check is needed after the bill is updated since it's impossible for a
        // credit to go into the Approved or Deleted state if they weren't already in these
        // states prior to the update.

        uint256 oldYieldInBps = cc.yieldInBps;
        cc.yieldInBps = uint16(yieldInBps);
        _setCreditConfig(creditHash, cc);

        uint256 principal = cr.unbilledPrincipal + cr.nextDue - cr.yieldDue + dd.principalPastDue;
        // Note that the new yield rate takes effect the next day. We need to:
        // 1. Deduct the yield that was computed with the previous rate from tomorrow onwards, and
        // 2. Incorporate the yield calculated with the new rate, also beginning tomorrow.
        dd.accrued = uint96(
            dueManager.recomputeYieldDue(
                cr.nextDueDate,
                dd.accrued,
                oldYieldInBps,
                yieldInBps,
                principal
            )
        );
        dd.committed = uint96(
            dueManager.recomputeYieldDue(
                cr.nextDueDate,
                dd.committed,
                oldYieldInBps,
                yieldInBps,
                cc.committedAmount
            )
        );
        uint256 updatedYieldDue = dd.committed > dd.accrued ? dd.committed : dd.accrued;
        uint256 unpaidYieldDue = updatedYieldDue > dd.paid ? updatedYieldDue - dd.paid : 0;
        cr.nextDue = uint96(cr.nextDue - cr.yieldDue + unpaidYieldDue);
        uint256 oldYieldDue = cr.yieldDue;
        cr.yieldDue = uint96(unpaidYieldDue);
        credit.updateDueInfo(creditHash, cr, dd);

        emit YieldUpdated(
            creditHash,
            oldYieldInBps,
            cc.yieldInBps,
            oldYieldDue,
            cr.yieldDue,
            msg.sender
        );
    }

    /**
     * @notice Updates credit limit and committed amount for the credit.
     * @notice It is possible that the credit limit is lower than what has been borrowed. No further
     * drawdown is allowed until the principal balance is below the limit again after payments.
     * @param creditHash The hash of the credit.
     * @param creditLimit The new credit limit to set.
     * @param committedAmount The new committed amount. The borrower will be charged interest for
     * this amount even if the daily average borrowing amount in a month is less than this amount.
     * @dev When committedAmount is changed, the yieldDue needs to be re-computed.
     */
    function _updateLimitAndCommitment(
        bytes32 creditHash,
        uint256 creditLimit,
        uint256 committedAmount
    ) internal virtual {
        if (creditLimit != 0 && committedAmount > creditLimit) {
            // If creditLimit is adjusted down to 0, then the intention is to temporarily prevent the borrower from
            // further drawdown, hence we allow a non-zero committedAmount here so that the borrower is still bound by
            // their existing commitment.
            revert Errors.CommittedAmountGreaterThanCreditLimit();
        }
        PoolSettings memory ps = poolConfig.getPoolSettings();
        if (creditLimit > ps.maxCreditLine) {
            revert Errors.CreditLimitTooHigh();
        }

        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.Approved || cr.state == CreditState.Deleted) {
            revert Errors.CreditNotInStateForUpdate();
        }
        CreditConfig memory cc = getCreditConfig(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
        // No state check is needed after the bill is updated since it's impossible for a
        // credit to go into the Approved or Deleted state if they weren't already in these
        // states prior to the update.

        uint256 oldCreditLimit = cc.creditLimit;
        cc.creditLimit = uint96(creditLimit);
        uint256 oldCommittedAmount = cc.committedAmount;
        cc.committedAmount = uint96(committedAmount);
        _setCreditConfig(creditHash, cc);

        dd.committed = uint96(
            dueManager.recomputeCommittedYieldDueAfterCommitmentChange(
                cr.nextDueDate,
                dd.committed,
                oldCommittedAmount,
                committedAmount,
                cc.yieldInBps
            )
        );
        uint256 updatedYieldDue = dd.committed > dd.accrued ? dd.committed : dd.accrued;
        uint256 unpaidYieldDue = updatedYieldDue > dd.paid ? updatedYieldDue - dd.paid : 0;
        cr.nextDue = uint96(cr.nextDue - cr.yieldDue + unpaidYieldDue);
        uint256 oldYieldDue = cr.yieldDue;
        cr.yieldDue = uint96(unpaidYieldDue);
        credit.updateDueInfo(creditHash, cr, dd);

        emit LimitAndCommitmentUpdated(
            creditHash,
            oldCreditLimit,
            cc.creditLimit,
            oldCommittedAmount,
            cc.committedAmount,
            oldYieldDue,
            cr.yieldDue,
            msg.sender
        );
    }

    /**
     * @notice Waives the late fee up to the given limit.
     * @param creditHash The hash of the credit.
     * @param amount The limit to be waived.
     * @return amountWaived The amount that has been waived.
     */
    function _waiveLateFee(
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountWaived) {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.Approved || cr.state == CreditState.Deleted) {
            revert Errors.CreditNotInStateForUpdate();
        }
        CreditConfig memory cc = getCreditConfig(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
        // No state check is needed after the bill is updated since it's impossible for a
        // credit to go into the Approved or Deleted state if they weren't already in these
        // states prior to the update.

        uint256 oldLateFee = dd.lateFee;
        amountWaived = amount > dd.lateFee ? dd.lateFee : amount;
        dd.lateFee -= uint96(amountWaived);
        cr.totalPastDue -= uint96(amountWaived);
        credit.updateDueInfo(creditHash, cr, dd);

        emit LateFeeWaived(creditHash, oldLateFee, dd.lateFee, msg.sender);
        return amountWaived;
    }

    /// Shared setter to the credit config mapping
    function _setCreditConfig(bytes32 creditHash, CreditConfig memory cc) internal {
        _creditConfigMap[creditHash] = cc;
    }

    function _isDefaultReady(
        PayPeriodDuration periodDuration,
        uint256 missedPeriods
    ) internal view returns (bool isDefault) {
        if (missedPeriods < 1) return false;
        PoolSettings memory settings = poolConfig.getPoolSettings();
        uint256 daysPassed = calendar.getDaysDiffSincePreviousPeriodStart(
            periodDuration,
            missedPeriods - 1,
            block.timestamp
        );
        // The `=` in the `>=` is crucial: the `daysPassed` above represents days elapsed
        // from `periodStartDate` to the **start** of the current day (as indicated by `block.timestamp`).
        // Without the `=`, the default could no longer be triggered during the current day, but only after
        // an additional full day has passed, which is incorrect.
        return daysPassed >= settings.defaultGracePeriodInDays;
    }

    /// "Modifier" function that limits access to eaServiceAccount only
    function _onlyEAServiceAccount() internal view {
        if (msg.sender != humaConfig.eaServiceAccount())
            revert Errors.EvaluationAgentServiceAccountRequired();
    }
}
