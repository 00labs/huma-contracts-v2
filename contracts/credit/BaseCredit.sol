// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, CreditQuota, BorrowerQuota, CreditLoss, CreditState, PaymentStatus, PnLTracker, Payment} from "./CreditStructs.sol";
import {IFlexCredit} from "./interfaces/IFlexCredit.sol";
import {IPoolCredit} from "./interfaces/IPoolCredit.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {IPnLManager} from "./interfaces/IPnLManager.sol";
import {ICreditFeeManager} from "./utils/interfaces/ICreditFeeManager.sol";
import {BaseCreditStorage} from "./BaseCreditStorage.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig, PoolSettings} from "../PoolConfig.sol";
import "../SharedDefs.sol";
import {HumaConfig} from "../HumaConfig.sol";
import {CalendarUnit} from "../SharedDefs.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PoolConfigCache} from "../PoolConfigCache.sol";
import {IPoolSafe} from "../interfaces/IPoolSafe.sol";
import {IFirstLossCover} from "../interfaces/IFirstLossCover.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "hardhat/console.sol";

/**
 * Credit is the basic borrowing entry in Huma Protocol.
 * BaseCredit is the base form of a Credit.
 * The key functions include: approve, drawdown, makePayment, refreshProfitAndLoss
 * Supporting functions include: updateCreditLine, closeCreditLine,
 *
 * Key design considerations:
 * 1) Refresh profit and loss by using an IProfitLossRefersher
 * 2) separate lastUpdateDate for profit and loss
 * 3) Mostly Credit-level limit, also supports borrower-level limit
 */
abstract contract BaseCredit is
    Initializable,
    PoolConfigCache,
    BaseCreditStorage,
    IPoolCredit,
    IFlexCredit
{
    enum CreditLineClosureReason {
        Paidoff,
        CreditLimitChangedToBeZero,
        OverwrittenByNewLine
    }

    /// Account billing info refreshed with the updated due amount and date
    event BillRefreshed(bytes32 indexed creditHash, uint256 newDueDate, uint256 amountDue);

    event BorrowerApproved(
        address borrower,
        uint96 creditLimit,
        uint16 numOfPeriods,
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving,
        bool receivableRequired,
        bool borrowerLevelCredit
    );

    event CreditConfigChanged(
        bytes32 indexed creditHash,
        uint256 creditLimit,
        uint256 committedAmount,
        CalendarUnit calendarUnit,
        uint256 periodDuration,
        uint256 numOfPeriods,
        uint256 yieldInBps,
        bool revolving,
        bool receivableBacked,
        bool borrowerLevelCredit,
        bool exclusive
    );

    /**
     * @notice Credit line created
     * @param borrower the address of the borrower
     * @param creditLimit the credit limit of the credit line
     * @param aprInBps interest rate (APR) expressed in basis points, 1% is 100, 100% is 10000
     * @param payPeriodInDays the number of days in each pay cycle
     * @param remainingPeriods how many cycles are there before the credit line expires
     * @param approved flag that shows if the credit line has been approved or not
     */
    event CreditInitiated(
        address indexed borrower,
        uint256 creditLimit,
        uint256 aprInBps,
        uint256 payPeriodInDays,
        uint256 remainingPeriods,
        bool approved
    );
    /// Credit limit for an existing credit line has been changed
    event CreditLineChanged(
        address indexed borrower,
        uint256 oldCreditLimit,
        uint256 newCreditLimit
    );

    /**
     * @notice An existing credit line has been closed
     * @param reasonCode the reason for the credit line closure
     */
    event CreditLineClosed(
        address indexed borrower,
        address by,
        CreditLineClosureReason reasonCode
    );
    /**
     * @notice The expiration (maturity) date of a credit line has been extended.
     * @param creditHash the credit hash
     * @param numOfPeriods the number of pay periods to be extended
     * @param remainingPeriods the remaining number of pay periods after the extension
     */
    event CreditLineExtended(
        bytes32 indexed creditHash,
        uint256 numOfPeriods,
        uint256 remainingPeriods,
        address by
    );
    /**
     * @notice The credit line has been marked as Defaulted.
     * @param borrower the address of the borrower
     * @param losses the total losses to be written off because of the default.
     * @param by the address who has triggered the default
     */
    event DefaultTriggered(address indexed borrower, uint256 losses, address by);
    /**
     * @notice A borrowing event has happened to the credit line
     * @param borrower the address of the borrower
     * @param borrowAmount the amount the user has borrowed
     * @param netAmountToBorrower the borrowing amount minus the fees that are charged upfront
     */
    event DrawdownMade(
        address indexed borrower,
        uint256 borrowAmount,
        uint256 netAmountToBorrower
    );
    /**
     * @notice A payment has been made against the credit line
     * @param borrower the address of the borrower
     * @param amount the payback amount
     * @param by the address that has triggered the process of marking the payment made.
     * In most cases, it is the borrower. In receivable factoring, it is PDSServiceAccount.
     */
    event PaymentMade(
        address indexed borrower,
        uint256 amount,
        uint256 totalDue,
        uint256 unbilledPrincipal,
        address by
    );

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = address(_poolConfig.humaConfig());
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        _humaConfig = HumaConfig(addr);

        addr = _poolConfig.creditFeeManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        _feeManager = ICreditFeeManager(addr);

        addr = _poolConfig.calendar();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        calendar = ICalendar(addr);

        addr = _poolConfig.creditPnLManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pnlManager = IPnLManager(addr);

        addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.getFirstLossCover(BORROWER_FIRST_LOSS_COVER_INDEX);
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        firstLossCover = IFirstLossCover(addr);
    }

    function _approveCredit(
        address borrower,
        bytes32 creditHash,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving
    ) internal virtual {
        if (borrower == address(0)) revert Errors.zeroAddressProvided();
        // if (creditHash == bytes32(0)) revert Errors.zeroAddressProvided(); ？
        if (creditLimit == 0) revert Errors.zeroAmountProvided();
        if (remainingPeriods == 0) revert Errors.zeroPayPeriods();
        // if (yieldInBps == 0) revert Errors.zeroAmountProvided(); ？
        // if (committedAmount == 0) revert Errors.zeroAmountProvided(); ？
        if (committedAmount > creditLimit) revert Errors.committedAmountGreatThanCreditLimit();

        PoolSettings memory ps = poolConfig.getPoolSettings();
        if (creditLimit > ps.maxCreditLine) {
            revert Errors.greaterThanMaxCreditLine();
        }

        // Before a drawdown happens, it is allowed to re-approve a credit to change ther terms.
        // Once a drawdown has happened, it is disallowed to re-approve a credit. One has call
        // other functions to change the terms of the credit.
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (cr.state >= CreditState.Approved) revert Errors.creditLineNotInStateForUpdate();

        CreditConfig memory cc = _getCreditConfig(creditHash);
        cc.creditLimit = uint96(creditLimit);
        cc.committedAmount = committedAmount;
        cc.calendarUnit = ps.calendarUnit;
        cc.periodDuration = ps.payPeriodInCalendarUnit;
        cc.numOfPeriods = uint16(remainingPeriods);
        cc.yieldInBps = uint16(yieldInBps);
        cc.revolving = revolving;
        _setCreditConfig(creditHash, cc);
        emit CreditConfigChanged(
            creditHash,
            cc.creditLimit,
            cc.committedAmount,
            cc.calendarUnit,
            cc.periodDuration,
            cc.numOfPeriods,
            cc.yieldInBps,
            cc.revolving,
            cc.receivableBacked,
            cc.borrowerLevelCredit,
            cc.exclusive
        );

        // Note: Special logic. dueDate is normally used to track the next bill due.
        // Before the first drawdown, it is also used to set the deadline for the first
        // drawdown to happen, otherwise, the credit line expires.
        // Decided to use this field in this way to save one field for the struct.
        // Although we have room in the struct after split struct creditRecord and
        // struct creditRecordStatic, we keep it unchanged to leave room for the struct
        // to expand in the future (note Solidity has limit on 13 fields in a struct)
        if (ps.creditApprovalExpirationInDays > 0)
            cr.nextDueDate = uint64(
                block.timestamp + ps.creditApprovalExpirationInDays * SECONDS_IN_A_DAY
            );
        cr.remainingPeriods = remainingPeriods;
        cr.state = CreditState.Approved;
        _setCreditRecord(creditHash, cr);
    }

    /**
     * @notice Closes a credit record.
     * @dev Only borrower or EA Service account can call this function
     * @dev Revert if there is still balance due
     * @dev Revert if the committed amount is non-zero and there are periods remaining
     */
    function _closeCredit(address borrower, bytes32 creditHash) internal virtual {
        onlyBorrowerOrEAServiceAccount(borrower);

        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (cr.totalDue != 0 || cr.unbilledPrincipal != 0) {
            revert Errors.creditLineHasOutstandingBalance();
        } else {
            CreditConfig memory cc = _getCreditConfig(creditHash);
            if (cc.committedAmount > 0 && cr.remainingPeriods > 0) revert Errors.todo();

            // Close the credit by removing relevant record.
            cr.state = CreditState.Deleted;
            cr.remainingPeriods = 0;
            _setCreditRecord(creditHash, cr);

            cc.creditLimit = 0;
            _setCreditConfig(creditHash, cc);
            //todo emit event
        }
    }

    /**
     * @notice Extend the expiration (maturity) date of a credit line
     * @param creditHash the hashcode of the credit
     * @param numOfPeriods the number of pay periods to be extended
     */
    function extendCreditLineDuration(bytes32 creditHash, uint256 numOfPeriods) public virtual {
        onlyEAServiceAccount();
        // Although it is not essential to call _updateDueInfo() to extend the credit line duration
        // it is good practice to bring the account current while we update one of the fields.
        // Also, only if we call _updateDueInfo(), we can write proper tests.
        _updateDueInfo(creditHash);
        _creditRecordMap[creditHash].remainingPeriods += uint16(numOfPeriods);
        emit CreditLineExtended(
            creditHash,
            numOfPeriods,
            _creditRecordMap[creditHash].remainingPeriods,
            msg.sender
        );
    }

    function _pauseCredit(bytes32 creditHash) internal {
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (cr.state == CreditState.GoodStanding) {
            cr.state = CreditState.Paused;
            _setCreditRecord(creditHash, cr);
        }
    }

    /**
     * @notice Updates the account and brings its billing status current
     * @dev If the account is defaulted, no need to update the account anymore.
     * @dev If the account is ready to be defaulted but not yet, update the account without
     * distributing the income for the upcoming period. Otherwise, update and distribute income
     * note the reason that we do not distribute income for the final cycle anymore since
     * it does not make sense to distribute income that we know cannot be collected to the
     * administrators (e.g. protocol, pool owner and EA) since it will only add more losses
     * to the LPs. Unfortunately, this special business consideration added more complexity
     * and cognitive load to _updateDueInfo(...).
     */
    function _refreshCredit(bytes32 creditHash) internal returns (CreditRecord memory cr) {
        if (_creditRecordMap[creditHash].state != CreditState.Defaulted) {
            return _updateDueInfo(creditHash);
        }
    }

    function refreshPnL() external returns (uint256 profit, uint256 loss, uint256 lossRecovery) {
        return pnlManager.refreshPnL();
    }

    /**
     * @notice Request the borrower to make extra principal payment in the next bill
     * @param amount the extra amount of principal to be paid
     * @dev the BaseCredit contract increases the due immediately, it is the caller's job
     * to call this function at the right time.
     * todo Add a new storage to record the extra principal due. We include it when calculate
     * the next bill so that the caller of this function does not have to time the request.
     */
    function requestEarlyPrincipalWithdrawal(
        bytes32 creditHash,
        uint96 amount
    ) external virtual override {
        // todo Only allows the Pool(?) contract to call
        // todo Check against poolConfig to make sure FlexCredit is allowed by this pool
        onlyPDSServiceAccount();
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (amount > cr.unbilledPrincipal) revert Errors.todo();
        cr.totalDue = uint96(cr.totalDue + amount);
        cr.unbilledPrincipal = uint96(cr.unbilledPrincipal - amount);
        _setCreditRecord(creditHash, cr);
    }

    /**
     * @notice Triggers the default process
     * @return losses the amount of remaining losses to the pool
     * @dev It is possible for the borrower to payback even after default, especially in
     * receivable factoring cases.
     */
    function _triggerDefault(bytes32 creditHash) internal virtual returns (uint256 losses) {
        poolConfig.onlyProtocolAndPoolOn();

        // check to make sure the default grace period has passed.
        CreditRecord memory cr = _getCreditRecord(creditHash);

        if (cr.state == CreditState.Defaulted) revert Errors.defaultHasAlreadyBeenTriggered();

        if (block.timestamp > cr.nextDueDate) {
            cr = _updateDueInfo(creditHash);
        }

        // Check if grace period has exceeded. Please note it takes a full pay period
        // before the account is considered to be late. The time passed should be one pay period
        // plus the grace period.
        // if (!isDefaultReady(borrower)) revert Errors.defaultTriggeredTooEarly();

        // // default amount includes all outstanding principals
        // losses = cr.unbilledPrincipal + cr.totalDue - cr.feesAndInterestDue;

        // _creditRecordMap[borrower].state = BS.CreditState.Defaulted;

        // _creditRecordStaticMap[borrower].defaultAmount = uint96(losses);

        // distributeLosses(losses);

        // emit DefaultTriggered(borrower, losses, msg.sender);

        return losses;
    }

    /**
     * @notice changes the available credit for a credit line. This is an administrative overwrite.
     * @param creditHash the owner of the credit line
     * @param newAvailableCredit the new available credit
     * @dev The credit line is marked as Deleted if 1) the new credit line is 0 AND
     * 2) there is no due or unbilled principals.
     * @dev only Evaluation Agent can call
     */
    function updateAvailableCredit(bytes32 creditHash, uint96 newAvailableCredit) public virtual {
        poolConfig.onlyProtocolAndPoolOn();
        onlyEAServiceAccount();

        if (newAvailableCredit > poolConfig.getPoolSettings().maxCreditLine) {
            revert Errors.greaterThanMaxCreditLine();
        }
        if (newAvailableCredit > _creditConfigMap[creditHash].creditLimit) {
            revert Errors.greaterThanMaxCreditLine();
        }
        CreditQuota memory quota = _creditQuotaMap[creditHash];
        quota.availableCredit = newAvailableCredit;
        _creditQuotaMap[creditHash] = quota;

        // Delete the credit record if the new limit is 0 and no outstanding balance
        if (newAvailableCredit == 0) {
            CreditRecord memory cr = _getCreditRecord(creditHash);
            if (cr.unbilledPrincipal == 0 && cr.totalDue == 0) {
                cr.state == CreditState.Deleted;
            }
            _setCreditRecord(creditHash, cr);
        }

        // emit CreditLineChanged(borrower, oldCreditLimit, newCreditLimit);
    }

    /**
     * @notice changes borrower's credit limit
     * @param borrower the borrower address
     * @param newCreditLimit the new limit of the line in the unit of pool token
     * @dev The credit line is marked as Deleted if 1) the new credit line is 0 AND
     * 2) there is no due or unbilled principals.
     * @dev only Evaluation Agent can call
     */
    function updateBorrowerLimit(address borrower, uint96 newCreditLimit) public virtual {
        poolConfig.onlyProtocolAndPoolOn();
        onlyEAServiceAccount();
        // Credit limit needs to be lower than max for the pool.
        if (newCreditLimit > poolConfig.getPoolSettings().maxCreditLine) {
            revert Errors.greaterThanMaxCreditLine();
        }
        BorrowerQuota memory quota = _borrowerQuotaMap[borrower];
        quota.creditLimit = newCreditLimit;
        _borrowerQuotaMap[borrower] = quota;

        // emit CreditLineChanged(borrower, oldCreditLimit, newCreditLimit);
    }

    function updateYield(address borrower, uint256 yieldInBps) public virtual {}

    function _unpauseCredit(bytes32 creditHash) internal virtual {
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (cr.state == CreditState.Paused) {
            cr.state = CreditState.GoodStanding;
            _setCreditRecord(creditHash, cr);
        }
    }

    function creditRecordMap(
        bytes32 creditHash
    ) public view virtual returns (CreditRecord memory) {
        return _creditRecordMap[creditHash];
    }

    function creditConfigMap(
        bytes32 creditHash
    ) public view virtual returns (CreditConfig memory) {
        return _creditConfigMap[creditHash];
    }

    function getAccruedPnL()
        external
        view
        returns (uint256 accruedProfit, uint256 accruedLoss, uint256 accruedLossRecovery)
    {
        return pnlManager.getPnLSum();
    }

    function getCreditHash(
        address borrower,
        uint256 receivableId
    ) public view virtual returns (bytes32 creditHash) {}

    function isApproved(bytes32 creditHash) public view virtual returns (bool) {
        if ((_creditRecordMap[creditHash].state >= CreditState.Approved)) return true;
        else return false;
    }

    /**
     * @notice checks if the credit line is ready to be triggered as defaulted
     */
    function isDefaultReady(bytes32 creditHash) public view virtual returns (bool isDefault) {
        // uint16 intervalInDays = _creditRecordStaticMap[creditHash].intervalInDays;
        // return
        //     _creditRecordMap[creditHash].missedPeriods * intervalInDays * SECONDS_IN_A_DAY >
        //         _poolConfig.poolDefaultGracePeriodInSeconds()
        //         ? true
        //         : false;
    }

    /** 
     * @notice checks if the credit line is behind in payments
     * @dev When the account is in Approved state, there is no borrowing yet, thus being late
     * does not apply. Thus the check on account state. 
     * @dev after the bill is refreshed, the due date is updated, it is possible that the new due 
     // date is in the future, but if the bill refresh has set missedPeriods, the account is late.
     */
    function isLate(bytes32 creditHash) public view virtual returns (bool lateFlag) {
        return
            (_creditRecordMap[creditHash].state > CreditState.Approved &&
                (_creditRecordMap[creditHash].missedPeriods > 0 ||
                    block.timestamp > _creditRecordMap[creditHash].nextDueDate))
                ? true
                : false;
    }

    /**
     * @notice Checks if drawdown is allowed for the credit line at this point of time
     * @dev Checks to make sure the following conditions are met:
     * 1) In Approved or Goodstanding state
     * 2) For first time drawdown, the approval is not expired
     * 3) Drawdown amount is no more than available credit
     * @dev Please note cr.nextDueDate is the credit expiration date for the first drawdown.
     */
    function _checkDrawdownEligibility(
        CreditRecord memory cr,
        uint256 borrowAmount,
        uint256 creditLimit
    ) internal view {
        if (cr.state != CreditState.GoodStanding && cr.state != CreditState.Approved)
            revert Errors.creditLineNotInStateForDrawdown();
        else if (cr.state == CreditState.Approved) {
            // After the credit approval, if the pool has credit expiration for the 1st drawdown,
            // the borrower must complete the first drawdown before the expiration date, which
            // is set in cr.nextDueDate in approveCredit().
            // note For pools without credit expiration for first drawdown, cr.nextDueDate is 0
            // before the first drawdown, thus the cr.nextDueDate > 0 condition in the check
            if (cr.nextDueDate > 0 && block.timestamp > cr.nextDueDate)
                revert Errors.creditExpiredDueToFirstDrawdownTooLate();

            if (borrowAmount > creditLimit) revert Errors.creditLineExceeded();
        }
    }

    /**
     * @notice drawdown helper function.
     * @param creditHash the credit hash
     * @param borrowAmount the amount to borrow
     * @dev Access control and eligibility check is done outside of this function.
     */
    function _drawdown(
        address borrower,
        bytes32 creditHash,
        uint256 borrowAmount
    ) internal virtual {
        if (!firstLossCover.isSufficient(borrower)) revert Errors.todo();

        CreditRecord memory cr = _getCreditRecord(creditHash);
        CreditConfig memory cc = _getCreditConfig(creditHash);
        _checkDrawdownEligibility(cr, borrowAmount, cc.creditLimit);

        if (cr.state == CreditState.Approved) {
            // Flow for first drawdown
            // Sets the principal, then generates the first bill and sets credit status
            _creditRecordMap[creditHash].unbilledPrincipal = uint96(borrowAmount);
            cr = _updateDueInfo(creditHash);
            console.log("cr.nextDueDate: %s", cr.nextDueDate);
            cr.state = CreditState.GoodStanding;
        } else {
            // Disallow repeated drawdown for non-revolving credit
            if (!cc.revolving) revert Errors.todo();

            // Bring the account current and check if it is still in good standing.
            if (block.timestamp > cr.nextDueDate) {
                cr = _updateDueInfo(creditHash);
                if (cr.state != CreditState.GoodStanding)
                    revert Errors.creditLineNotInGoodStandingState();
            }

            // note Drawdown is not allowed in the final pay period since the payment due for
            // such drawdown will fall outside of the window of the credit line.
            // note since we bill at the beginning of a period, cr.remainingPeriods is zero
            // in the final period.
            if (cr.remainingPeriods == 0) revert Errors.creditExpiredDueToMaturity();

            if (
                borrowAmount >
                (cc.creditLimit - cr.unbilledPrincipal - (cr.totalDue - cr.feesDue - cr.yieldDue))
            ) revert Errors.creditLineExceeded();

            uint256 correctionYield = (borrowAmount *
                cc.yieldInBps *
                (cr.nextDueDate - block.timestamp)) /
                SECONDS_IN_A_YEAR /
                HUNDRED_PERCENT_IN_BPS;
            cr.yieldDue += uint96(correctionYield);
            cr.totalDue += uint96(correctionYield);
            cr.unbilledPrincipal = uint96(cr.unbilledPrincipal + borrowAmount);
        }
        _setCreditRecord(creditHash, cr);

        (uint256 netAmountToBorrower, uint256 platformProfit) = _feeManager.distBorrowingAmount(
            borrowAmount
        );

        pnlManager.processDrawdown(
            uint96(platformProfit),
            uint96(
                (borrowAmount * cc.yieldInBps * DEFAULT_DECIMALS_FACTOR) /
                    (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
            )
        );

        // Transfer funds to the _borrower
        poolSafe.withdraw(borrower, netAmountToBorrower);
        emit DrawdownMade(borrower, borrowAmount, netAmountToBorrower);
    }

    /**
     * @notice Borrower makes one payment. If the payment amount equals to or is higher
     * than the payoff amount, it automatically triggers the payoff process. The protocol
     * never accepts payment amount that is higher than the payoff amount.
     * @param creditHash the hashcode of the credit
     * @param amount the payment amount
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indicating whether the account has been paid off.
     * @return isReviewRequired a flag indicating whether this payment transaction has been
     * flagged for review.
     */
    function _makePayment(
        address borrower,
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountPaid, bool paidoff, bool isReviewRequired) {
        if (amount == 0) revert Errors.zeroAmountProvided();
        CreditRecord memory cr = _getCreditRecord(creditHash);
        CreditConfig memory cc = _getCreditConfig(creditHash);

        if (block.timestamp > cr.nextDueDate) {
            cr = _updateDueInfo(creditHash);
        }

        // todo this is not the ideal place for this logic. Ideally, updateDueInfo() should handle this
        // Reverse late charge if it is paid before the late fee grace period
        {
            if (cr.state == CreditState.Delayed) {
                (uint256 beginOfPeriod, ) = calendar.getBeginOfPeriod(
                    cc.calendarUnit,
                    cc.periodDuration,
                    cr.nextDueDate
                );
                if (
                    block.timestamp <
                    (beginOfPeriod +
                        poolConfig.getPoolSettings().latePaymentGracePeriodInDays *
                        SECONDS_IN_A_DAY)
                ) {
                    // todo cr.totalDue should be updated as well, cr.state might need to be updated too.
                    // Safe to set feesDue to zero since the fees for the previous cycles should have been rolled into principals.
                    cr.feesDue = 0;
                }
            }
        }

        uint256 payoffAmount = _feeManager.getPayoffAmount(cr, cc.yieldInBps);

        // The amount to collect from the payer's wallet.
        Payment memory p = Payment(0, 0, 0, 0, cr.state == CreditState.GoodStanding, false);

        if (amount < payoffAmount) {
            p.amountToCollect = uint96(amount);
            if (amount < cr.totalDue) {
                // Handle principal payment
                p.principalPaid = (amount <= cr.totalDue - cr.feesDue - cr.yieldDue)
                    ? uint96(amount)
                    : cr.totalDue - cr.feesDue - cr.yieldDue;
                amount -= p.principalPaid;

                // Handle interest payment.
                if (amount > 0) {
                    p.yieldPaid = amount <= cr.yieldDue ? uint96(amount) : cr.yieldDue;
                    cr.yieldDue -= uint96(p.yieldPaid);
                    amount -= p.yieldPaid;
                }

                // Handle fee payment.
                if (amount > 0) {
                    p.feesPaid = uint96(amount);
                    cr.feesDue -= uint96(p.feesPaid);
                }

                cr.totalDue = uint96(cr.totalDue - amount);
            } else {
                // Apply extra payments towards principal, reduce unbilledPrincipal amount
                cr.unbilledPrincipal -= uint96(amount - cr.totalDue);
                p.principalPaid = uint96(amount - cr.feesDue - cr.yieldDue);
                cr.totalDue = 0;
                cr.feesDue = 0;
                cr.yieldDue = 0;
                cr.missedPeriods = 0;
                // Moves account to GoodStanding if it was delayed.
                if (cr.state == CreditState.Delayed) cr.state = CreditState.GoodStanding;
            }
        } else {
            // Payoff
            p.principalPaid = cr.unbilledPrincipal + cr.totalDue - cr.feesDue - cr.yieldDue;
            p.feesPaid = cr.feesDue;
            p.yieldPaid = cr.yieldDue;
            p.amountToCollect = uint96(payoffAmount);

            cr.unbilledPrincipal = 0;
            cr.feesDue = 0;
            cr.yieldDue = 0;
            cr.totalDue = 0;
            cr.missedPeriods = 0;
            // Closes the credit line if it is in the final period
            if (cr.remainingPeriods == 0) {
                cr.state = CreditState.Deleted;
                emit CreditLineClosed(borrower, msg.sender, CreditLineClosureReason.Paidoff);
            } else cr.state = CreditState.GoodStanding;
        }

        if (p.amountToCollect > 0) {
            poolSafe.deposit(borrower, p.amountToCollect);
            emit PaymentMade(
                borrower,
                p.amountToCollect,
                cr.totalDue,
                cr.unbilledPrincipal,
                msg.sender
            );
        }
        _setCreditRecord(creditHash, cr);

        pnlManager.processPayback(
            creditHash,
            p.principalPaid,
            p.yieldPaid,
            p.feesPaid,
            uint16(cc.yieldInBps),
            p.oldLateFlag,
            cr.state == CreditState.GoodStanding
        );

        // p.amountToCollect == payoffAmount indicates payoff or not. >= is a safe practice
        return (p.amountToCollect, p.amountToCollect >= payoffAmount, false);
    }

    /// Shared setter to the credit config mapping
    function _setCreditConfig(bytes32 creditHash, CreditConfig memory cc) internal {
        _creditConfigMap[creditHash] = cc;
    }

    /// Shared setter to the credit record mapping for contract size consideration
    function _setCreditRecord(bytes32 creditHash, CreditRecord memory cr) internal {
        _creditRecordMap[creditHash] = cr;
    }

    /**
     * @notice updates CreditRecord for `creditHash` using the most up to date information.
     * @dev this is used in both makePayment() and drawdown() to bring the account current
     * @dev getDueInfo() is a view function to get the due information of the most current cycle.
     * This function reflects the due info in creditRecordMap
     * @param creditHash the hash of the credit
     */
    function _updateDueInfo(bytes32 creditHash) internal virtual returns (CreditRecord memory cr) {
        cr = _getCreditRecord(creditHash);

        // Do not update dueInfo for accounts already in default state
        if (cr.state == CreditState.Defaulted) return cr;

        // Before the first drawdown, cr.nextDueDate is used to capture credit expiration
        // date. It is validated in the precheck logic for the first drawdown, thus safe
        // to reset cr.nextDueDate to 0 to remove special handling in getDueInfo().
        if (cr.state == CreditState.Approved) cr.nextDueDate = 0;

        // Gets the up-to-date due information for the borrower. If the account has been
        // late or dormant for multiple cycles, getDueInfo() will bring it current and
        // return the most up-to-date due information.
        CreditConfig memory cc = _getCreditConfig(creditHash);
        uint256 periodsPassed = 0;
        uint96 missedProfit = 0;
        uint96 principalDiff = 0;
        uint96 lossImpact = 0;
        CreditRecord memory oldCR = cr;

        (cr, periodsPassed, missedProfit, principalDiff, lossImpact) = _feeManager.getDueInfo(
            cr,
            cc
        );
        console.log(
            "cr.totalDue: %s, cr.yieldDue: %s, periodsPassed: %s",
            cr.totalDue,
            cr.yieldDue,
            periodsPassed
        );
        console.log("missedProfit: %s, principalDiff: %s", missedProfit, principalDiff);

        if (periodsPassed > 0) {
            bool alreadyLate = lossImpact > 0;
            if (alreadyLate) {
                pnlManager.processDueUpdate(
                    principalDiff,
                    missedProfit,
                    lossImpact,
                    creditHash,
                    cc,
                    oldCR
                );
            }

            // Adjusts remainingPeriods, special handling when reached the maturity of the credit line
            if (cr.remainingPeriods > periodsPassed) {
                cr.remainingPeriods = uint16(cr.remainingPeriods - periodsPassed);
            } else {
                cr.remainingPeriods = 0;
            }

            // Sets the correct missedPeriods. If totalDue is non zero, the totalDue must be
            // nonZero for each of the passed period, thus add periodsPassed to cr.missedPeriods
            if (alreadyLate) cr.missedPeriods = uint16(cr.missedPeriods + periodsPassed);
            else cr.missedPeriods = 0;

            if (cr.missedPeriods > 0) {
                if (cr.state != CreditState.Defaulted) {
                    cr.state = CreditState.Delayed;
                    PoolSettings memory ps = poolConfig.getPoolSettings();
                    if (
                        (cr.missedPeriods - 1) * ps.payPeriodInCalendarUnit >=
                        ps.defaultGracePeriodInCalendarUnit
                    ) {
                        cr.state = CreditState.Defaulted;
                        pnlManager.processDefault(creditHash, cc, cr);

                        // TODO how to recover defaulted state?
                    }
                }
            } else cr.state = CreditState.GoodStanding;

            _setCreditRecord(creditHash, cr);

            emit BillRefreshed(creditHash, cr.nextDueDate, cr.totalDue);
        }
    }

    /// Shared accessor to the credit config mapping for contract size consideration
    function _getCreditConfig(bytes32 creditHash) internal view returns (CreditConfig memory) {
        return _creditConfigMap[creditHash];
    }

    /// Shared accessor to the credit record mapping for contract size consideration
    function _getCreditRecord(bytes32 creditHash) internal view returns (CreditRecord memory) {
        return _creditRecordMap[creditHash];
    }

    /// Shared accessor to the credit record mapping for contract size consideration
    function _getBorrowerRecord(address borrower) internal view returns (CreditConfig memory) {
        return _borrowerConfigMap[borrower];
    }

    function _isOverdue(uint256 dueDate) internal view returns (bool) {}

    /// "Modifier" function that limits access to eaServiceAccount only
    function onlyBorrowerOrEAServiceAccount(address borrower) internal view {
        if (msg.sender != borrower && msg.sender != _humaConfig.eaServiceAccount())
            revert Errors.evaluationAgentServiceAccountRequired();
    }

    /// "Modifier" function that limits access to eaServiceAccount only
    function onlyEAServiceAccount() internal view {
        if (msg.sender != _humaConfig.eaServiceAccount())
            revert Errors.evaluationAgentServiceAccountRequired();
    }

    /// "Modifier" function that limits access to pdsServiceAccount only.
    function onlyPDSServiceAccount() internal view {
        if (msg.sender != HumaConfig(_humaConfig).pdsServiceAccount())
            revert Errors.paymentDetectionServiceAccountRequired();
    }

    // todo provide an external view function for credit payment due list ?
}
