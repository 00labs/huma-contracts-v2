// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

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

import "hardhat/console.sol";

abstract contract CreditManager is PoolConfigCache, CreditManagerStorage, ICreditManager {
    event CommittedCreditStarted(bytes32 indexed creditHash);

    event CreditPaused(bytes32 indexed creditHash);

    event CreditUnpaused(bytes32 indexed creditHash);

    /**
     * @notice An existing credit has been closed
     * @param creditHash the credit hash
     * @param reasonCode the reason for the credit closure
     * @param by the address who has closed the credit
     */
    event CreditClosed(bytes32 indexed creditHash, CreditClosureReason reasonCode, address by);

    /**
     * @notice The credit line has been marked as Defaulted.
     * @param creditHash the credit hash
     * @param principalLoss the principal losses to be written off because of the default.
     * @param by the address who has triggered the default
     */
    event DefaultTriggered(
        bytes32 indexed creditHash,
        uint256 principalLoss,
        uint256 yieldLoss,
        uint256 feesLoss,
        address by
    );

    /**
     * @notice The expiration (maturity) date of a credit line has been extended.
     * @param creditHash the credit hash
     * @param oldRemainingPeriods the number of remaining pay periods before the extension
     * @param newRemainingPeriods the number of remaining pay periods after the extension
     * @param by The address who has triggered the update.
     */
    event RemainingPeriodsExtended(
        bytes32 indexed creditHash,
        uint256 oldRemainingPeriods,
        uint256 newRemainingPeriods,
        address by
    );

    /**
     * @notice The expiration (maturity) date of a credit line has been extended.
     * @param creditHash The credit hash.
     * @param oldYieldInBps The old yield in basis points before the update.
     * @param newYieldInBps The new yield in basis points limit after the update.
     * @param oldYieldDue The old amount of yield due before the update.
     * @param newYieldDue The new amount of yield due after the update.
     * @param by The address who has triggered the update.
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
     * @notice The expiration (maturity) date of a credit line has been extended.
     * @param creditHash The credit hash.
     * @param oldLimit The old credit limit before the update.
     * @param newLimit The new credit limit after the update.
     * @param oldCommittedAmount The old committed amount before the update.
     * @param newCommittedAmount The new committed amount after the update.
     * @param oldYieldDue The old amount of yield due before the update.
     * @param newYieldDue The new amount of yield due after the update.
     * @param by The address who has triggered the update.
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
     * @notice The expiration (maturity) date of a credit line has been extended.
     * @param creditHash The credit hash.
     * @param oldLateFee The amount of late fee before the update.
     * @param newLateFee The amount of late fee after the update.
     * @param by The address who has triggered the update.
     */
    event LateFeeWaived(
        bytes32 indexed creditHash,
        uint256 oldLateFee,
        uint256 newLateFee,
        address by
    );

    function getCreditBorrower(bytes32 creditHash) external view returns (address) {
        return _creditBorrowerMap[creditHash];
    }

    /**
     * @notice checks if the credit line is ready to be triggered as defaulted
     */
    function isDefaultReady(bytes32 creditHash) public view virtual returns (bool isReady) {
        CreditConfig memory cc = getCreditConfig(creditHash);
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        (cr, ) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
        return _isDefaultReady(cc.periodDuration, cr.missedPeriods);
    }

    /// Shared accessor to the credit config mapping for contract size consideration
    function getCreditConfig(bytes32 creditHash) public view returns (CreditConfig memory) {
        return _creditConfigMap[creditHash];
    }

    function onlyCreditBorrower(bytes32 creditHash, address borrower) public view {
        if (borrower != _creditBorrowerMap[creditHash]) revert Errors.notBorrower();
    }

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
     * @notice Approves a credit indexed by creditHash
     * @param borrower the borrower of the credit
     * @param creditHash the credit hash of the credit
     * @param creditLimit the credit limit
     * @param remainingPeriods the number of periods until maturity
     * @param yieldInBps yield of the credit measured in basis points
     * @param revolving whether the credit is revolving or not
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

        if (borrower == address(0)) revert Errors.zeroAddressProvided();
        if (creditLimit == 0) revert Errors.zeroAmountProvided();
        if (remainingPeriods == 0) revert Errors.zeroPayPeriods();
        if (committedAmount > creditLimit) revert Errors.committedAmountGreaterThanCreditLimit();
        // It doesn't make sense for a credit to have no commitment but a non-zero designated startt date.
        if (committedAmount == 0 && designatedStartDate != 0)
            revert Errors.creditWithoutCommitmentShouldHaveNoDesignatedStartDate();
        if (designatedStartDate > 0 && block.timestamp > designatedStartDate)
            revert Errors.designatedStartDateInThePast();
        if (designatedStartDate > 0 && remainingPeriods <= 1)
            revert Errors.PayPeriodsTooLowForCreditsWithDesignatedStartDate();

        PoolSettings memory ps = poolConfig.getPoolSettings();
        if (creditLimit > ps.maxCreditLine) {
            revert Errors.greaterThanMaxCreditLine();
        }

        // Before a drawdown happens, it is allowed to re-approve a credit to change the terms.
        // Once a drawdown has happened, it is disallowed to re-approve a credit. One has to call
        // other admin functions to change the terms of the credit.
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state > CreditState.Approved) revert Errors.creditLineNotInStateForUpdate();

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
     * @notice startCommittedCredit helper function.
     * @dev Access control is done outside of this function.
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
            revert Errors.committedCreditCannotBeStarted();
        }
        CreditConfig memory cc = getCreditConfig(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        (cr, dd) = dueManager.getDueInfo(cr, cc, dd, cr.nextDueDate);
        credit.updateDueInfo(creditHash, cr, dd);

        emit CommittedCreditStarted(creditHash);
    }

    /**
     * @notice Closes a credit record.
     * @dev The calling function is responsible for access control
     * @dev Revert if there is still balance due
     * @dev Revert if the committed amount is non-zero and there are periods remaining
     */
    function _closeCredit(bytes32 creditHash) internal virtual {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.nextDue != 0 || cr.totalPastDue != 0 || cr.unbilledPrincipal != 0) {
            revert Errors.creditLineHasOutstandingBalance();
        }

        CreditConfig memory cc = getCreditConfig(creditHash);
        if (cr.state != CreditState.Approved && cc.committedAmount > 0 && cr.remainingPeriods > 0)
            // If a credit has started and has unfulfilled commitment, then don't allow it to be closed.
            revert Errors.creditLineHasUnfulfilledCommitment();

        // Close the credit by removing relevant record.
        cr.state = CreditState.Deleted;
        cr.remainingPeriods = 0;
        credit.setCreditRecord(creditHash, cr);

        cc.creditLimit = 0;
        _setCreditConfig(creditHash, cc);

        emit CreditClosed(creditHash, CreditClosureReason.AdminClosure, msg.sender);
    }

    function _pauseCredit(bytes32 creditHash) internal {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.GoodStanding) {
            cr.state = CreditState.Paused;
            credit.setCreditRecord(creditHash, cr);
            emit CreditPaused(creditHash);
        }
    }

    function _unpauseCredit(bytes32 creditHash) internal virtual {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.Paused) {
            cr.state = CreditState.GoodStanding;
            credit.setCreditRecord(creditHash, cr);
            emit CreditUnpaused(creditHash);
        }
    }

    /**
     * @notice Updates the account and brings its billing status current
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
     * @notice Triggers the default process
     * @return principalLoss the amount of principal loss
     * @dev It is possible for the borrower to payback even after default, especially in
     * receivable factoring cases.
     */
    function _triggerDefault(
        bytes32 creditHash
    ) internal virtual returns (uint256 principalLoss, uint256 yieldLoss, uint256 feesLoss) {
        // check to make sure the default grace period has passed.
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.Defaulted) revert Errors.defaultHasAlreadyBeenTriggered();

        CreditConfig memory cc = getCreditConfig(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);

        // Check if grace period has been exceeded.
        if (!_isDefaultReady(cc.periodDuration, cr.missedPeriods))
            revert Errors.defaultTriggeredTooEarly();

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
     * @notice Extend the expiration (maturity) date of a credit
     * @param creditHash the hashcode of the credit
     * @param newNumOfPeriods the number of pay periods to be extended
     */
    function _extendRemainingPeriod(bytes32 creditHash, uint256 newNumOfPeriods) internal virtual {
        // Although not essential to call getDueInfo() to extend the credit line duration,
        // it is still a good practice to bring the account current while we update one of the fields.
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state != CreditState.GoodStanding) {
            revert Errors.creditLineNotInStateForUpdate();
        }
        CreditConfig memory cc = getCreditConfig(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        (cr, dd) = dueManager.getDueInfo(cr, cc, dd, block.timestamp);
        if (cr.state != CreditState.GoodStanding) {
            revert Errors.creditLineNotInStateForUpdate();
        }

        cc.numOfPeriods += uint16(newNumOfPeriods);
        _setCreditConfig(creditHash, cc);

        uint256 oldRemainingPeriods = cr.remainingPeriods;
        cr.remainingPeriods += uint16(newNumOfPeriods);
        credit.updateDueInfo(creditHash, cr, dd);

        emit RemainingPeriodsExtended(
            creditHash,
            oldRemainingPeriods,
            cr.remainingPeriods,
            msg.sender
        );
    }

    function _updateYield(bytes32 creditHash, uint256 yieldInBps) internal virtual {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.Approved || cr.state == CreditState.Deleted) {
            revert Errors.creditLineNotInStateForUpdate();
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
            dueManager.computeUpdatedYieldDue(
                cr.nextDueDate,
                dd.accrued,
                oldYieldInBps,
                yieldInBps,
                principal
            )
        );
        dd.committed = uint96(
            dueManager.computeUpdatedYieldDue(
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
     * @dev It is possible that the credit limit is lower than what has been borrowed. No further
     * drawdown is allowed until the principal balance is below the limit again after payments.
     * @dev When committedAmount is changed, the yieldDue needs to be re-computed.
     */
    function _updateLimitAndCommitment(
        bytes32 creditHash,
        uint256 creditLimit,
        uint256 committedAmount
    ) internal virtual {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.Approved || cr.state == CreditState.Deleted) {
            revert Errors.creditLineNotInStateForUpdate();
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
            dueManager.computeUpdatedYieldDue(
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

    function _waiveLateFee(
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountWaived) {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.Approved || cr.state == CreditState.Deleted) {
            revert Errors.creditLineNotInStateForUpdate();
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
            revert Errors.evaluationAgentServiceAccountRequired();
    }
}
