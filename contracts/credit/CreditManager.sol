// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {HumaConfig} from "../HumaConfig.sol";
import {ICredit} from "./interfaces/ICredit.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {IPool} from "../interfaces/IPool.sol";
import {ICreditManager} from "./interfaces/ICreditManager.sol";
import {PoolConfig, PoolSettings} from "../PoolConfig.sol";
import {PoolConfigCache} from "../PoolConfigCache.sol";
import {CreditManagerStorage} from "./CreditManagerStorage.sol";
import {CreditConfig, CreditLimit, CreditRecord, CreditState, DueDetail, PayPeriodDuration, CreditLoss} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";
import {DAYS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS, SECONDS_IN_A_DAY} from "../SharedDefs.sol";

abstract contract CreditManager is PoolConfigCache, CreditManagerStorage, ICreditManager {
    event CreditConfigChanged(
        bytes32 indexed creditHash,
        uint256 creditLimit,
        uint256 committedAmount,
        PayPeriodDuration periodDuration,
        uint256 numOfPeriods,
        uint256 yieldInBps,
        bool revolving,
        uint256 advanceRateInBps,
        bool autoApproval
    );

    event CommittedCreditStarted(bytes32 indexed creditHash);

    event CreditPaused(bytes32 indexed creditHash);

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
     */
    event RemainingPeriodsExtended(
        bytes32 indexed creditHash,
        uint256 oldRemainingPeriods,
        uint256 newRemainingPeriods,
        address by
    );

    /**
     * @notice checks if the credit line is ready to be triggered as defaulted
     */
    function isDefaultReady(bytes32 creditHash) public view virtual returns (bool isDefault) {
        return _isDefaultReady(credit.getCreditRecord(creditHash));
    }

    /// Shared accessor to the credit config mapping for contract size consideration
    function getCreditConfig(bytes32 creditHash) public view returns (CreditConfig memory) {
        return _creditConfigMap[creditHash];
    }

    function onlyCreditBorrower(bytes32 creditHash, address borrower) public view {
        if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = address(_poolConfig.humaConfig());
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        humaConfig = HumaConfig(addr);

        addr = _poolConfig.calendar();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        calendar = ICalendar(addr);

        addr = _poolConfig.credit();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        credit = ICredit(addr);
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
        if (borrower == address(0)) revert Errors.zeroAddressProvided();
        if (creditHash == bytes32(0)) revert Errors.zeroAddressProvided();
        if (creditLimit == 0) revert Errors.zeroAmountProvided();
        if (remainingPeriods == 0) revert Errors.zeroPayPeriods();
        if (committedAmount > creditLimit) revert Errors.committedAmountGreaterThanCreditLimit();
        // It doesn't make sense for a credit to have no commitment but a non-zero designated startt date.
        if (committedAmount == 0 && designatedStartDate != 0)
            revert Errors.creditWithoutCommitmentShouldHaveNoDesignatedStartDate();
        if (designatedStartDate > 0 && block.timestamp > designatedStartDate)
            revert Errors.designatedStartDateInThePast();

        PoolSettings memory ps = poolConfig.getPoolSettings();
        if (creditLimit > ps.maxCreditLine) {
            revert Errors.greaterThanMaxCreditLine();
        }

        // Before a drawdown happens, it is allowed to re-approve a credit to change the terms.
        // Once a drawdown has happened, it is disallowed to re-approve a credit. One has to call
        // other admin functions to change the terms of the credit.
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        // TODO(jiatu): we shouldn't rely on the order of enum values.
        if (cr.state > CreditState.Approved) revert Errors.creditLineNotInStateForUpdate();

        CreditConfig memory cc = getCreditConfig(creditHash);
        cc.creditLimit = creditLimit;
        cc.committedAmount = committedAmount;
        cc.periodDuration = ps.payPeriodDuration;
        cc.numOfPeriods = remainingPeriods;
        cc.yieldInBps = yieldInBps;
        cc.revolving = revolving;
        cc.advanceRateInBps = ps.advanceRateInBps;
        cc.autoApproval = ps.receivableAutoApproval;
        _setCreditConfig(creditHash, cc);

        // todo decide if this event emission should be kept or not
        // TODO decide if cc.receivableBacked, cc.borrowerLevelCredit and cc.exclusive should be kept or not
        emit CreditConfigChanged(
            creditHash,
            cc.creditLimit,
            cc.committedAmount,
            cc.periodDuration,
            cc.numOfPeriods,
            cc.yieldInBps,
            cc.revolving,
            cc.advanceRateInBps,
            cc.autoApproval
        );

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

        creditBorrowerMap[creditHash] = borrower;
    }

    /**
     * @notice startCommittedCredit helper function.
     * @dev Access control is done outside of this function.
     */
    function _startCommittedCredit(address borrower, bytes32 creditHash) internal virtual {
        CreditConfig memory cc = getCreditConfig(creditHash);
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
        credit.setMaturityDate(
            creditHash,
            calendar.getMaturityDate(cc.periodDuration, cc.numOfPeriods, block.timestamp)
        );
        DueDetail memory dd;
        credit.updateDueInfo(creditHash);

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

        // TODO really need this?
        cc.creditLimit = 0;
        _setCreditConfig(creditHash, cc);
    }

    function _pauseCredit(bytes32 creditHash) internal {
        _onlyEAServiceAccount();
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.GoodStanding) {
            cr.state = CreditState.Paused;
            credit.setCreditRecord(creditHash, cr);
        }
        emit CreditPaused(creditHash);
    }

    function _unpauseCredit(bytes32 creditHash) internal virtual {
        _onlyEAServiceAccount();
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state == CreditState.Paused) {
            cr.state = CreditState.GoodStanding;
            credit.setCreditRecord(creditHash, cr);
        }
    }

    /**
     * @notice Updates the account and brings its billing status current
     * @dev If the account is defaulted, no need to update the account anymore.
     * @dev If the account is ready to be defaulted but not yet, update the account without
     * distributing the income for the upcoming period. Otherwise, update and distribute income.
     * Note the reason that we do not distribute income in the final cycle anymore since
     * it does not make sense to distribute income that we know cannot be collected to the
     * administrators (e.g. protocol, pool owner and EA) since it will only add more losses
     * to the LPs. Unfortunately, this special business consideration added more complexity
     * and cognitive load to `updateDueInfo`.
     */
    function _refreshCredit(bytes32 creditHash) internal {
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        if (cr.state != CreditState.Approved && cr.state != CreditState.Deleted) {
            // There is nothing to refresh when:
            // 1. the credit is approved but hasn't started yet;
            // 2. the credit has already been closed.
            credit.updateDueInfo(creditHash);
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
        poolConfig.onlyProtocolAndPoolOn();

        // check to make sure the default grace period has passed.
        CreditRecord memory cr = credit.getCreditRecord(creditHash);
        DueDetail memory dd = credit.getDueDetail(creditHash);
        if (cr.state == CreditState.Defaulted) revert Errors.defaultHasAlreadyBeenTriggered();

        (cr, ) = credit.updateDueInfo(creditHash);

        // Check if grace period has been exceeded.
        if (!_isDefaultReady(cr)) revert Errors.defaultTriggeredTooEarly();

        principalLoss = cr.unbilledPrincipal + cr.nextDue - cr.yieldDue + dd.principalPastDue;
        yieldLoss = cr.yieldDue + dd.yieldPastDue;
        feesLoss = dd.lateFee;

        CreditLoss memory cl = credit.getCreditLoss(creditHash);
        cl.principalLoss += uint96(principalLoss);
        cl.yieldLoss += uint96(yieldLoss);
        cl.feesLoss += uint96(feesLoss);
        credit.setCreditLoss(creditHash, cl);

        IPool(poolConfig.pool()).distributeLoss(
            uint256(cl.principalLoss + cl.yieldLoss + cl.feesLoss)
        );

        cr.state = CreditState.Defaulted;
        credit.setCreditRecord(creditHash, cr);
        emit DefaultTriggered(creditHash, principalLoss, yieldLoss, feesLoss, msg.sender);
    }

    /**
     * @notice Extend the expiration (maturity) date of a credit
     * @param creditHash the hashcode of the credit
     * @param newNumOfPeriods the number of pay periods to be extended
     */
    function _extendRemainingPeriod(bytes32 creditHash, uint256 newNumOfPeriods) internal virtual {
        // Although not essential to call updateDueInfo() to extend the credit line duration,
        // it is still a good practice to bring the account current while we update one of the fields.
        (CreditRecord memory cr, ) = credit.updateDueInfo(creditHash);

        CreditConfig memory cc = getCreditConfig(creditHash);
        cc.numOfPeriods += uint16(newNumOfPeriods);
        _setCreditConfig(creditHash, cc);

        uint256 oldRemainingPeriods = cr.remainingPeriods;
        cr.remainingPeriods += uint16(newNumOfPeriods);
        credit.setCreditRecord(creditHash, cr);

        emit RemainingPeriodsExtended(
            creditHash,
            oldRemainingPeriods,
            cr.remainingPeriods,
            msg.sender
        );
    }

    function _updateYield(bytes32 creditHash, uint256 yieldInBps) internal virtual {
        (CreditRecord memory cr, DueDetail memory dd) = credit.updateDueInfo(creditHash);

        CreditConfig memory cc = getCreditConfig(creditHash);
        uint256 principal = cr.unbilledPrincipal + cr.nextDue - cr.yieldDue + dd.principalPastDue;
        // Note that the new yield rate takes effect the next day. We need to:
        // 1. Deduct the yield that was computed with the previous rate from tomorrow onwards, and
        // 2. Incorporate the yield calculated with the new rate, also beginning tomorrow.
        dd.accrued = uint96(
            _computeUpdatedYield(cc, cr, dd.accrued, cc.yieldInBps, yieldInBps, principal)
        );
        dd.committed = uint96(
            _computeUpdatedYield(
                cc,
                cr,
                dd.committed,
                cc.yieldInBps,
                yieldInBps,
                cc.committedAmount
            )
        );
        uint256 updatedYieldDue = dd.committed > dd.accrued ? dd.committed : dd.accrued;
        cr.nextDue = uint96(cr.nextDue - cr.yieldDue + updatedYieldDue);
        cr.yieldDue = uint96(updatedYieldDue);
        credit.setCreditRecord(creditHash, cr);
        credit.setDueDetail(creditHash, dd);
        // TODO emit event. Need to report old bps, new bps, old yieldDue, new yieldDue
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
        CreditConfig memory cc = getCreditConfig(creditHash);
        (CreditRecord memory cr, DueDetail memory dd) = credit.updateDueInfo(creditHash);

        cc.creditLimit = uint96(creditLimit);
        cc.committedAmount = uint96(committedAmount);
        _setCreditConfig(creditHash, cc);

        dd.committed = uint96(
            _computeUpdatedYield(
                cc,
                cr,
                dd.committed,
                cc.committedAmount,
                committedAmount,
                cc.yieldInBps
            )
        );
        uint256 updatedYieldDue = dd.committed > dd.accrued ? dd.committed : dd.accrued;
        cr.nextDue = uint96(cr.nextDue - cr.yieldDue + updatedYieldDue);
        cr.yieldDue = uint96(updatedYieldDue);
        credit.setCreditRecord(creditHash, cr);
        credit.setDueDetail(creditHash, dd);
        // TODO emit event
    }

    function _waiveLateFee(
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountWaived) {
        (CreditRecord memory cr, DueDetail memory dd) = credit.updateDueInfo(creditHash);
        amountWaived = amount > dd.lateFee ? dd.lateFee : amount;
        dd.lateFee -= uint96(amountWaived);
        cr.totalPastDue -= uint96(amountWaived);
        credit.setDueDetail(creditHash, dd);
        credit.setCreditRecord(creditHash, cr);
        return amountWaived;
    }

    /**
     * @notice Returns the difference in yield due to the value that the yield is calculated from changed from the old
     * value to the new value.
     */
    function _computeUpdatedYield(
        CreditConfig memory cc,
        CreditRecord memory cr,
        uint256 oldYield,
        uint256 oldValue,
        uint256 newValue,
        uint256 multiplier
    ) internal view returns (uint256 updatedYield) {
        (uint256 daysPassed, uint256 totalDays) = calendar.getDaysPassedInPeriod(
            cc.periodDuration,
            cr.nextDueDate
        );
        // Since the new value may be smaller than the old value, we need to work with signed integers.
        int256 valueDiff = int256(newValue) - int256(oldValue);
        int256 yieldDiff = (int256((totalDays - daysPassed) * multiplier) * valueDiff) /
            int256(HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR);
        return uint256(int256(oldYield) + yieldDiff);
    }

    /// Shared setter to the credit config mapping
    function _setCreditConfig(bytes32 creditHash, CreditConfig memory cc) internal {
        _creditConfigMap[creditHash] = cc;
    }

    function _isDefaultReady(CreditRecord memory cr) internal view returns (bool isDefault) {
        PoolSettings memory settings = poolConfig.getPoolSettings();
        // TODO(jiatu): this implementation is utterly incorrect. We need to fix how default is calculated.
        return
            cr.missedPeriods > 1 &&
            (cr.missedPeriods - 1) * 30 >= settings.defaultGracePeriodInMonths;
    }

    /// "Modifier" function that limits access to eaServiceAccount only
    function _onlyEAServiceAccount() internal view {
        if (msg.sender != humaConfig.eaServiceAccount())
            revert Errors.evaluationAgentServiceAccountRequired();
    }

    function _onlyPDSServiceAccount() internal view {
        if (msg.sender != HumaConfig(humaConfig).pdsServiceAccount())
            revert Errors.paymentDetectionServiceAccountRequired();
    }
}
