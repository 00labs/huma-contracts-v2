// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, CreditProfit, CreditLoss, CreditState, PaymentStatus, PnLTracker} from "./CreditStructs.sol";
import {ICreditFeeManager} from "./utils/interfaces/ICreditFeeManager.sol";
import {ICredit} from "./interfaces/ICredit.sol";
import {IFlexCredit} from "./interfaces/IFlexCredit.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {BaseCreditStorage} from "./BaseCreditStorage.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig} from "../PoolConfig.sol";
import "../SharedDefs.sol";
import {HumaConfig} from "../HumaConfig.sol";
import {CalendarUnit} from "../SharedDefs.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PnLManager} from "./PnLManager.sol";

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
contract BaseCredit is BaseCreditStorage, ICredit, IFlexCredit {
    using SafeERC20 for IERC20;
    ICalendar calendar;
    PnLManager pnlManager;

    enum CreditLineClosureReason {
        Paidoff,
        CreditLimitChangedToBeZero,
        OverwrittenByNewLine
    }

    /// Account billing info refreshed with the updated due amount and date
    event BillRefreshed(
        bytes32 indexed creditHash,
        uint256 newDueDate,
        uint256 amountDue,
        address borrower
    );
    /// Credit line request has been approved
    event CreditApproved(
        address indexed borrower,
        uint256 creditLimit,
        uint256 intervalInDays,
        uint256 remainingPeriods,
        uint256 aprInBps
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

    /**
     * @notice approve a borrower with the
     * @param borrower the borrower address
     * @param creditLimit the credit limit at the borrower level
     * @param calendarUnit calendar unit type: Day or Semimonth
     * @param periodDuration period duration in calendarUnit
     * @param numOfPeriods how many periods are approved for the borrower
     * @param committedAmount the amount the borrower committed to use.
     * The yield will be computed using the max of this amount and the acutal credit used.
     */
    function approveBorrower(
        address borrower,
        uint96 creditLimit,
        CalendarUnit calendarUnit, // days or semimonth
        uint16 periodDuration,
        uint16 numOfPeriods, // number of periods
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving, // whether repeated borrowing is allowed
        bool receivableRequired,
        bool borrowerLevelCredit
    ) external virtual override {
        _protocolAndPoolOn();
        onlyEAServiceAccount();

        if (creditLimit <= 0) revert();
        if (periodDuration <= 0) revert();
        if (numOfPeriods <= 0) revert();

        _borrowerConfigMap[borrower] = CreditConfig(
            creditLimit,
            committedAmount,
            calendarUnit,
            periodDuration,
            numOfPeriods,
            yieldInBps,
            revolving,
            receivableRequired,
            borrowerLevelCredit,
            true
        );

        // :emit BorrowerApproved(borrower, creditLimit);
    }

    function getCreditHash(address borrower) public view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), borrower));
    }

    function getCreditHash(
        address borrower,
        address receivableAsset,
        uint256 receivableId
    ) public view virtual returns (bytes32 creditHash) {}

    // /**
    //  * @notice Approves the credit request with the terms provided.
    //  * @param borrower the borrower address
    //  * @param creditLimit the credit limit of the credit line
    //  * @param calendarUnit how the period is measured, by days or by semimonth
    //  * @param payPeriodInCalendarUnit the multiple of the calendarUnit
    //  * @param remainingPeriods how many cycles are there before the credit line expires
    //  * @param yieldInBps expected yield expressed in basis points, 1% is 100, 100% is 10000
    //  * @dev only Evaluation Agent can call
    //  */
    // function approveCredit(
    //     address borrower,
    //     uint96 creditLimit,
    //     CalendarUnit calendarUnit,
    //     uint16 payPeriodInCalendarUnit,
    //     uint16 remainingPeriods,
    //     uint16 yieldInBps,
    //     uint96 committedAmount,
    //     bool revolving
    // ) external virtual {
    //     _protocolAndPoolOn();
    //     onlyEAServiceAccount();
    //     if (payPeriodInCalendarUnit == 0) revert Errors.requestedCreditWithZeroDuration();
    //     if (remainingPeriods == 0) revert Errors.zeroPayPeriods();
    //     if (creditLimit == 0) revert();

    //     // :Need to check both are credit level and borrower level
    //     _maxCreditLineCheck(creditLimit);

    //     // Update to a credit record is disallowed if there is drawdown already
    //     bytes32 creditHash = getCreditHash(borrower);
    //     CreditRecord memory cr = _getCreditRecord(creditHash);
    //     if (cr.state >= CreditState.Approved) revert Errors.creditLineNotInStateForUpdate();

    //     CreditConfig memory cc = _getCreditConfig(creditHash);
    //     cc.creditLimit = uint96(creditLimit);
    //     cc.calendarUnit = CalendarUnit(calendarUnit);
    //     cc.periodDuration = uint8(payPeriodInCalendarUnit);
    //     cc.numOfPeriods = uint16(remainingPeriods);
    //     cc.yieldInBps = uint16(yieldInBps);
    //     cc.revolving = revolving;

    //     _setCreditConfig(creditHash, cc);

    //     // :emit CreditApproved(borrower, creditLimit, intervalInDays, remainingPeriods, aprInBps);
    // }

    function closeCredit(bytes32 creditHash) public virtual {
        // :only borrower or EA
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (cr.totalDue != 0 || cr.unbilledPrincipal != 0) {
            revert Errors.creditLineHasOutstandingBalance();
        }
        // :revert if the pool requires committed loan
        else {
            // Close the credit by removing relevant record.
            cr.state = CreditState.Deleted;
            _setCreditRecord(creditHash, cr);

            CreditConfig memory cc = _getCreditConfig(creditHash);
            cc.creditLimit = 0;
            _setCreditConfig(creditHash, cc);
        }
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
        _protocolAndPoolOn();
        onlyEAServiceAccount();
        // Credit limit needs to be lower than max for the pool.
        _maxCreditLineCheck(newCreditLimit);
        _borrowerConfigMap[borrower].creditLimit = newCreditLimit;

        // emit CreditLineChanged(borrower, oldCreditLimit, newCreditLimit);
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
        _protocolAndPoolOn();
        onlyEAServiceAccount();
        // Credit limit needs to be lower than max for the pool.
        // :check against borrower credit limit
        _maxCreditLineCheck(newAvailableCredit);

        CreditRecord memory cr = _getCreditRecord(creditHash);
        cr.availableCredit = newAvailableCredit;
        // Delete the credit record if the new limit is 0 and no outstanding balance
        if (newAvailableCredit == 0) {
            if (cr.unbilledPrincipal == 0 && cr.totalDue == 0) {
                cr.state == CreditState.Deleted;
            }
        }
        _setCreditRecord(creditHash, cr);

        // emit CreditLineChanged(borrower, oldCreditLimit, newCreditLimit);
    }

    /**
     * @notice Request the borrower to make extra principal payment in the next bill
     * @param amount the extra amount of principal to be paid
     * @dev the BaseCredit contract increases the due immediately, it is the caller's job
     * to call this function at the right time.
     * todo Add a new storage to record the extra principal due. We include it when calculate
     * the next bill so that the caller of this function does not have to time the request.
     */
    function requestEarlyPrincipalWithdrawal(uint96 amount) external virtual override {
        // todo Only allows the Pool(?) contract to call
        // todo Check against poolConfig to make sure FlexCredit is allowed by this pool
        if (activeCreditsHash.length != 1) revert Errors.todo();
        _getCreditRecord(activeCreditsHash[0]).totalDue += amount;
    }

    /**
     * @notice allows the borrower to borrow against an approved credit line.
     * @param creditHash hash of the credit record
     * @param borrowAmount the amount to borrow
     * @dev Only the owner of the credit line can drawdown.
     */
    function drawdown(bytes32 creditHash, uint256 borrowAmount) external virtual override {
        if (borrowAmount == 0) revert Errors.zeroAmountProvided();
        address borrower = msg.sender;
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (borrower != cr.borrower) revert Errors.notBorrower();

        _checkDrawdownEligibility(cr, borrowAmount);
        uint256 netAmountToBorrower = _drawdown(creditHash, cr, borrowAmount);
        emit DrawdownMade(borrower, borrowAmount, netAmountToBorrower);
    }

    /**
     * @notice The expiration (maturity) date of a credit line has been extended.
     * @param creditHash the hashcode of the credit
     * @param numOfPeriods the number of pay periods to be extended
     */
    function extendCreditLineDuration(bytes32 creditHash, uint256 numOfPeriods) external virtual {
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

    /**
     * @notice Makes one payment for the borrower. This can be initiated by the borrower
     * or by PDSServiceAccount with the allowance approval from the borrower.
     * If this is the final payment, it automatically triggers the payoff process.
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indicating whether the account has been paid off.
     * @notice Warning, payments should be made by calling this function
     * No token should be transferred directly to the contract
     */
    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) public virtual override returns (uint256 amountPaid, bool paidoff) {
        address borrower = _getCreditRecord(creditHash).borrower;
        if (msg.sender != borrower) onlyPDSServiceAccount();
        (amountPaid, paidoff, ) = _makePayment(creditHash, amount);

        _payToCredit(creditHash, amount);
        // transfer amount from msg.sender
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
    function refreshCredit(bytes32 creditHash) external virtual returns (CreditRecord memory cr) {
        if (_creditRecordMap[creditHash].state != CreditState.Defaulted) {
            return _updateDueInfo(creditHash);
        }
    }

    /**
     * @notice Triggers the default process
     * @return losses the amount of remaining losses to the pool
     * @dev It is possible for the borrower to payback even after default, especially in
     * receivable factoring cases.
     */
    function triggerDefault(bytes32 creditHash) external virtual returns (uint256 losses) {
        _protocolAndPoolOn();

        // // check to make sure the default grace period has passed.
        // CreditRecord memory cr = _getCreditRecord(borrower);

        // if (cr.state == BS.CreditState.Defaulted) revert Errors.defaultHasAlreadyBeenTriggered();

        // if (block.timestamp > cr.nextDueDate) {
        //     cr = _updateDueInfo(borrower, false, false);
        // }

        // // Check if grace period has exceeded. Please note it takes a full pay period
        // // before the account is considered to be late. The time passed should be one pay period
        // // plus the grace period.
        // if (!isDefaultReady(borrower)) revert Errors.defaultTriggeredTooEarly();

        // // default amount includes all outstanding principals
        // losses = cr.unbilledPrincipal + cr.totalDue - cr.feesAndInterestDue;

        // _creditRecordMap[borrower].state = BS.CreditState.Defaulted;

        // _creditRecordStaticMap[borrower].defaultAmount = uint96(losses);

        // distributeLosses(losses);

        // emit DefaultTriggered(borrower, losses, msg.sender);

        // return losses;
    }

    function creditRecordMap(bytes32 creditHash) external view returns (CreditRecord memory) {
        return _creditRecordMap[creditHash];
    }

    function creditConfigMap(bytes32 creditHash) external view returns (CreditConfig memory) {
        return _creditConfigMap[creditHash];
    }

    function isApproved(bytes32 creditHash) external view virtual returns (bool) {
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
    function isLate(bytes32 creditHash) external view virtual returns (bool lateFlag) {
        return
            (_creditRecordMap[creditHash].state > CreditState.Approved &&
                (_creditRecordMap[creditHash].missedPeriods > 0 ||
                    block.timestamp > _creditRecordMap[creditHash].nextDueDate))
                ? true
                : false;
    }

    function _approveCredit(
        CreditRecord memory cr
    ) internal view returns (CreditRecord memory cro) {
        // if (cr.state > BS.CreditState.Approved) revert Errors.creditLineOutstanding();
        // // Note: Special logic. dueDate is normally used to track the next bill due.
        // // Before the first drawdown, it is also used to set the deadline for the first
        // // drawdown to happen, otherwise, the credit line expires.
        // // Decided to use this field in this way to save one field for the struct.
        // // Although we have room in the struct after split struct creditRecord and
        // // struct creditRecordStatic, we keep it unchanged to leave room for the struct
        // // to expand in the future (note Solidity has limit on 13 fields in a struct)
        // uint256 validPeriod = _poolConfig.creditApprovalExpirationInSeconds();
        // if (validPeriod > 0) cr.nextDueDate = uint64(block.timestamp + validPeriod);
        // cr.state = BS.CreditState.Approved;
        // return cr;
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
        uint256 borrowAmount
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

            if (borrowAmount > cr.availableCredit) revert Errors.creditLineExceeded();
        }
    }

    /**
     * @notice drawdown helper function. Eligibility check is done outside this function.
     * @param creditHash the credit hash
     * @param borrowAmount the amount to borrow
     */
    function _drawdown(
        bytes32 creditHash,
        CreditRecord memory cr,
        uint256 borrowAmount
    ) internal virtual returns (uint256) {
        CreditConfig memory cc = _getCreditConfig(creditHash);

        if (cr.state == CreditState.Approved) {
            // Flow for first drawdown
            // Sets the prinicpal, then generates the first bill and sets credit status
            _creditRecordMap[creditHash].unbilledPrincipal = uint96(borrowAmount);
            cr = _updateDueInfo(creditHash);
            cr.state = CreditState.GoodStanding;
        } else {
            // Disallow repeated drawdown for non-revolving credit
            if (!cr.revolving) revert Errors.todo();

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

            // todo This is not exactly right. need to check the maintenance of availableCredit logic
            if (
                borrowAmount >
                (cr.availableCredit -
                    cr.unbilledPrincipal -
                    (cr.totalDue - cr.feesDue - cr.yieldDue))
            ) revert Errors.creditLineExceeded();

            (uint256 nextDueDate, ) = calendar.getNextDueDate(
                cc.calendarUnit,
                cc.periodDuration,
                cr.nextDueDate
            );

            // Adds the interest for the rest of this period to the balance due
            cr.yieldDue += uint96(
                (borrowAmount * cc.yieldInBps * (nextDueDate - block.timestamp)) /
                    SECONDS_IN_A_YEAR
            );

            cr.unbilledPrincipal = uint96(cr.unbilledPrincipal + borrowAmount);
        }
        _setCreditRecord(creditHash, cr);
        (uint256 netAmountToBorrower, uint256 platformFees) = _feeManager.distBorrowingAmount(
            borrowAmount
        );

        uint256 poolIncome = 0;
        if (platformFees > 0) poolIncome = distributeIncome(platformFees);

        pnlManager.processDrawdown(
            uint96(poolIncome),
            uint96((borrowAmount * cc.yieldInBps) / SECONDS_IN_A_YEAR)
        );

        // Transfer funds to the _borrower
        _underlyingToken.safeTransfer(cr.borrower, netAmountToBorrower);
        return netAmountToBorrower;
    }

    /**
     * @notice initiation of a credit line
     * @param borrower the address of the borrower
     * @param creditLimit the amount of the liquidity asset that the borrower obtains
     */
    function _initiateCredit(
        address borrower,
        uint256 creditLimit,
        uint256 aprInBps,
        uint256 intervalInDays,
        uint256 remainingPeriods,
        bool preApproved
    ) internal virtual {
        // if (remainingPeriods == 0) revert Errors.requestedCreditWithZeroDuration();
        // _protocolAndPoolOn();
        // // Borrowers cannot have two credit lines in one pool. They can request to increase line.
        // CreditRecord memory cr = _getCreditRecord(borrower);
        // if (cr.state != BS.CreditState.Deleted) {
        //     // If the user has an existing line, but there is no balance, close the old one
        //     // and initiate the new one automatically.
        //     cr = _updateDueInfo(borrower, false, true);
        //     if (cr.totalDue == 0 && cr.unbilledPrincipal == 0) {
        //         cr.state = BS.CreditState.Deleted;
        //         cr.remainingPeriods = 0;
        //         emit CreditLineClosed(
        //             borrower,
        //             msg.sender,
        //             CreditLineClosureReason.OverwrittenByNewLine
        //         );
        //     } else {
        //         revert Errors.creditLineAlreadyExists();
        //     }
        // }
        // // Borrowing amount needs to be lower than max for the pool.
        // _maxCreditLineCheck(creditLimit);
        // _creditRecordStaticMap[borrower] = CreditRecordStatic({
        //     creditLimit: uint96(creditLimit),
        //     aprInBps: uint16(aprInBps),
        //     intervalInDays: uint16(intervalInDays),
        //     defaultAmount: uint96(0)
        // });
        // CreditRecord memory ncr;
        // ncr.remainingPeriods = uint16(remainingPeriods);
        // if (preApproved) {
        //     ncr = _approveCredit(ncr);
        //     emit CreditApproved(borrower, creditLimit, intervalInDays, remainingPeriods, aprInBps);
        // } else ncr.state = BS.CreditState.Requested;
        // _setCreditRecord(borrower, ncr);
        // emit CreditInitiated(
        //     borrower,
        //     creditLimit,
        //     aprInBps,
        //     intervalInDays,
        //     remainingPeriods,
        //     preApproved
        // );
    }

    /**
     * @notice Borrower makes one payment. If this is the final payment,
     * it automatically triggers the payoff process.
     * @param creditHash the hashcode of the credit
     * @param amount the payment amount
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indciating whether the account has been paid off.
     * @return isReviewRequired a flag indicating whether this payment transaction has been
     * flagged for review.
     */
    function _makePayment(
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountPaid, bool paidoff, bool isReviewRequired) {
        _protocolAndPoolOn();
        if (amount == 0) revert Errors.zeroAmountProvided();
        CreditRecord memory cr = _getCreditRecord(creditHash);
        CreditConfig memory cc = _getCreditConfig(creditHash);

        address borrower = cr.borrower;

        if (block.timestamp > cr.nextDueDate) {
            // Bring the account current in case it is dormant for several periods.
            cr = _updateDueInfo(creditHash);
        }

        // Reverse late charge if it is paid before the late fee grace period
        // todo cr.nextDueDate is already updated to the next cycle. Next to check
        // against the previous cycle's due date. Need to add a function in Calendar
        // to find previous dueDate.
        if (cr.state == CreditState.Delayed) {
            if (
                block.timestamp <
                cr.nextDueDate +
                    _poolConfig.getPoolSettings().latePaymentGracePeriodInDays *
                    SECONDS_IN_A_DAY
            ) {
                // Setting feesDue is safe since the fees for the previous cycles should have been rolled into principals.
                // todo review this carefully.
                cr.feesDue = 0;
            }
        }

        // Compute the payoffAmount. Need to exclude the interest
        // from now to the end of the period
        uint256 payoffAmount = uint256(cr.totalDue + cr.unbilledPrincipal);
        //todo move this to a function in feeManager for better readability
        uint256 remainingInterest = (cc.yieldInBps *
            (cr.totalDue - cr.yieldDue - cr.feesDue) *
            (cr.nextDueDate - block.timestamp)) / SECONDS_IN_A_YEAR;
        assert(payoffAmount >= remainingInterest);
        payoffAmount -= remainingInterest;

        // The amount to collect from the payer's wallet.
        uint256 amountToCollect;
        // The amount to be applied towards principal
        uint256 principalPaid = 0;
        uint256 yieldPaid = 0;
        uint256 feesPaid = 0;
        CreditState oldState = cr.state;

        if (amount < payoffAmount) {
            amountToCollect = amount;
            if (amount < cr.totalDue) {
                // Handle principal payment
                if (amount < cr.totalDue - cr.feesDue - cr.yieldDue) principalPaid = amount;
                else principalPaid = cr.totalDue - cr.feesDue - cr.yieldDue;
                amount -= principalPaid;

                // Handle interest payment.
                if (amount > 0) {
                    yieldPaid = amount <= cr.yieldDue ? amount : cr.yieldDue;
                    cr.yieldDue -= uint96(yieldPaid);
                    amount -= yieldPaid;
                }

                // Handle fee payment.
                if (amount > 0) {
                    feesPaid = amount;
                    cr.feesDue -= uint96(feesPaid);
                }

                cr.totalDue = uint96(cr.totalDue - principalPaid - yieldPaid - feesPaid);
            } else {
                // Apply extra payments towards principal, reduce unbilledPrincipal amount
                cr.unbilledPrincipal -= uint96(amount - cr.totalDue);
                principalPaid = amount - cr.feesDue - cr.yieldDue;
                cr.totalDue = 0;
                cr.feesDue = 0;
                cr.yieldDue = 0;
                cr.missedPeriods = 0;
                // Moves account to GoodStanding if it was delayed.
                if (cr.state == CreditState.Delayed) cr.state = CreditState.GoodStanding;
            }

            // PnL change
            // todo feesPaid should be applied towards totalProfit.
            // todo if principalPaid > 0,  update profitRate
            if (cr.state == CreditState.Delayed) {
                // todo principalPaid and yieldPaid should be used to decrease totalMarkdown,
            }
        } else {
            // Payoff
            principalPaid = cr.unbilledPrincipal + cr.totalDue - cr.feesDue - cr.yieldDue;
            feesPaid = cr.feesDue;
            yieldPaid = cr.yieldDue;
            amountToCollect = payoffAmount;

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

        // Handle default recovery
        if (oldState > CreditState.GoodStanding) {
            // Add all payments to
        }

        _updatePnl(principalPaid, yieldPaid, feesPaid, cc.yieldInBps);

        _setCreditRecord(creditHash, cr);

        if (amountToCollect > 0) {
            // Transfer assets from the _borrower to pool locker
            _underlyingToken.safeTransferFrom(borrower, address(this), amountToCollect);
            emit PaymentMade(
                borrower,
                amountToCollect,
                cr.totalDue,
                cr.unbilledPrincipal,
                msg.sender
            );
        }
        // amountToCollect == payoffAmount indicates whether it is paid off or not.
        // Use >= as a safe practice
        return (amountToCollect, amountToCollect >= payoffAmount, false);
    }

    /**
     * @notice Recovers amount when a payment is paid towards a defaulted account.
     * @dev For any payment after a default, it is applied towards principal losses first.
     * Only after the principal is fully recovered, it is applied towards fees & interest.
     */
    function _recoverDefaultedAmount(bytes32 creditHash, uint256 amountToCollect) internal {
        //
        // uint96 _defaultAmount = _creditRecordStaticMap[borrower].defaultAmount;
        // if (_defaultAmount > 0) {
        //     uint256 recoveredPrincipal;
        //     if (_defaultAmount >= amountToCollect) {
        //         recoveredPrincipal = amountToCollect;
        //     } else {
        //         recoveredPrincipal = _defaultAmount;
        //         distributeIncome(amountToCollect - recoveredPrincipal);
        //     }
        //     _totalPoolValue += recoveredPrincipal;
        //     _defaultAmount -= uint96(recoveredPrincipal);
        //     _creditRecordStaticMap[borrower].defaultAmount = _defaultAmount;
        // } else {
        //     // note The account is moved out of Defaulted state only if the entire due
        //     // including principals, fees&Interest are paid off. It is possible for
        //     // the account to owe fees&Interest after _defaultAmount becomes zero.
        //     distributeIncome(amountToCollect);
        // }
    }

    /// Checks if the given amount is higher than what is allowed by the pool
    function _maxCreditLineCheck(uint256 amount) internal view {
        // if (amount > _poolConfig.maxCreditLine()) {
        //     revert Errors.greaterThanMaxCreditLine();
        // }
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
        uint96 pnlImpact = 0;
        uint96 principalDifference = 0;
        (
            periodsPassed,
            cr.feesDue,
            cr.yieldDue,
            cr.totalDue,
            cr.unbilledPrincipal,
            pnlImpact,
            principalDifference
        ) = _feeManager.getDueInfo(cr, cc);

        pnlManager.processDueUpdate(
            pnlImpact,
            uint96((principalDifference * cc.yieldInBps) / SECONDS_IN_A_YEAR)
        );

        if (periodsPassed > 0) {
            // update nextDueDate
            (uint256 dueDate, ) = calendar.getNextDueDate(
                cc.calendarUnit,
                cc.periodDuration,
                cr.nextDueDate
            );
            cr.nextDueDate = uint64(dueDate);

            // Adjusts remainingPeriods, special handling when reached the maturity of the credit line
            if (cr.remainingPeriods > periodsPassed) {
                cr.remainingPeriods = uint16(cr.remainingPeriods - periodsPassed);
            } else {
                cr.remainingPeriods = 0;
            }

            // Sets the correct missedPeriods. If totalDue is non zero, the totalDue must be
            // nonZero for each of the passed period, thus add periodsPassed to cr.missedPeriods
            if (cr.totalDue > 0) cr.missedPeriods = uint16(cr.missedPeriods + periodsPassed);
            else cr.missedPeriods = 0;

            if (cr.missedPeriods > 0) {
                if (cr.state != CreditState.Defaulted) cr.state = CreditState.Delayed;
            } else cr.state = CreditState.GoodStanding;

            _setCreditRecord(creditHash, cr);

            emit BillRefreshed(creditHash, cr.nextDueDate, cr.totalDue, cr.borrower);
        }
    }

    /// Shared setter to the credit record mapping for contract size consideration
    function _setCreditRecord(bytes32 creditHash, CreditRecord memory cr) internal {
        _creditRecordMap[creditHash] = cr;
    }

    /// Shared accessor to the credit record mapping for contract size consideration
    function _getBorrowerRecord(address borrower) internal view returns (CreditConfig memory) {
        return _borrowerConfigMap[borrower];
    }

    /// Shared accessor to the credit config mapping for contract size consideration
    function _getCreditConfig(bytes32 creditHash) internal view returns (CreditConfig memory) {
        return _creditConfigMap[creditHash];
    }

    /// Shared accessor to the credit record mapping for contract size consideration
    function _getCreditRecord(bytes32 creditHash) internal view returns (CreditRecord memory) {
        return _creditRecordMap[creditHash];
    }

    /// Shared setter to the credit config mapping
    function _setCreditConfig(bytes32 creditHash, CreditConfig memory cc) internal {
        _creditConfigMap[creditHash] = cc;
    }

    /// "Modifier" function that limits access to pdsServiceAccount only.
    function onlyPDSServiceAccount() internal view {
        // if (msg.sender != HumaConfig(_humaConfig).pdsServiceAccount())
        //     revert Errors.paymentDetectionServiceAccountRequired();
    }

    /// "Modifier" function that limits access to eaServiceAccount only
    function onlyEAServiceAccount() internal view {
        // if (msg.sender != _humaConfig.eaServiceAccount())
        //     revert Errors.evaluationAgentServiceAccountRequired();
    }

    function submitPrincipalWithdrawal(uint256 amount) external {}

    /// "Modifier" function that limits access only when both protocol and pool are on.
    /// Did not use modifier for contract size consideration.
    function _protocolAndPoolOn() internal view {
        // if (_humaConfig.paused()) revert Errors.protocolIsPaused();
        // if (_status != PoolStatus.On) revert Errors.poolIsNotOn();
    }

    /**
     * @notice Updates loan data when borrowers borrow
     * @param creditHash a unique hash for the loan
     * @param amount borrowed amount
     */
    function _borrowFromCredit(bytes32 creditHash, uint256 amount) internal {
        // check parameters & permission
        // CreditInfo memory creditInfo = credits[creditHash];
        // if (creditInfo.startTime == 0) {
        //     // the first drawdown
        //     // initialize a loan
        //     creditInfo.startTime = uint64(block.timestamp);
        //     creditInfo.checkPoint.totalPrincipal = uint96(amount);
        //     creditInfo.state = CreditState.GoodStanding;
        //     creditInfo.checkPoint.lastProfitUpdatedTime = uint64(block.timestamp);
        // } else {
        //     // drawdown for an existing loan
        //     uint256 accruedInterest;
        //     uint256 accruedPrincipalLoss;
        //     // update loan data(interest, principal) to current time
        //     (accruedInterest, accruedPrincipalLoss) = _refreshCredit(creditHash, creditInfo);
        //     if (accruedInterest > 0) totalAccruedProfit += accruedInterest;
        //     if (accruedPrincipalLoss > 0) totalAccruedLoss += accruedPrincipalLoss;
        //     // update the drawdown amount
        //     // creditInfo.checkPoint.totalPrincipal += uint96(amount);
        // }
        // // store loan data
        // credits[creditHash] = creditInfo;
        // // :update credit due to current time
        // // :update totalDue and unbilledPrincipal
    }

    function _refreshCredit(
        bytes32 creditHash,
        CreditRecord memory creditRecord
    ) internal view returns (uint256 accruedInterest, uint256 accruedPrincipalLoss) {
        // CreditConfig memory creditConfig = creditConfigs[creditHash];
        // CreditDueInfo memory creditDue = creditDues[creditHash];
        // if (creditInfo.state == CreditState.GoodStanding && _isOverdue(creditDue.nextDueDate)) {
        //     // :move credit from active array to overdue array
        //     // :update credit state to overdue
        // }
        // // :if credit is active(GoodStanding?)
        // accruedInterest = _refreshCreditProfit(creditInfo, creditConfig);
        // // :return
        // // :if credit is overdue(delayed?)
        // accruedPrincipalLoss = _refreshCreditLoss(creditInfo, creditConfig);
        // // :return
    }

    /**
     * Refresh profit for a credit
     */
    function _refreshCreditProfit(
        CreditRecord memory cr,
        CreditConfig memory cc
    ) internal view returns (uint256 accruedInterest) {
        // (uint256 accruedInterest, uint256 accruedPrincipal) = _feeManager.accruedDebt(
        //     creditInfo.checkPoint.totalPrincipal - creditInfo.checkPoint.totalPaidPrincipal,
        //     creditInfo.startTime,
        //     creditInfo.checkPoint.lastProfitUpdatedTime,
        //     creditConfig
        // );
        // creditInfo.checkPoint.totalAccruedInterest += uint96(accruedInterest);
        // creditInfo.checkPoint.totalAccruedPrincipal += uint96(accruedPrincipal);
        // creditInfo.checkPoint.lastProfitUpdatedTime = uint64(block.timestamp);
        // return accruedInterest;
    }

    function _refreshCreditLoss(
        CreditRecord memory creditRecord,
        CreditConfig memory creditConfig
    ) internal view returns (uint256 loss) {
        // uint256 loss;
        // // :calculate accrued credit loss
        // creditInfo.checkPoint.totalAccruedLoss += uint96(loss);
        // creditInfo.checkPoint.lastLossUpdatedTime = uint64(block.timestamp);
        // return loss;
    }

    /**
     * @notice Updates loan data when borrowers pay
     * @param creditHash a unique hash for the loan
     * @param amount paid amount
     */
    function _payToCredit(bytes32 creditHash, uint256 amount) internal {
        // check parameters & permission
        // CreditRecord memory creditRecord = credits[creditHash];
        // // :update due info
        // // update loan data(interest, principal) to current time
        // (uint256 accruedInterest, uint256 accruedPrincipalLoss) = _refreshCredit(
        //     creditHash,
        //     creditInfo
        // );
        // if (creditInfo.state == CreditState.GoodStanding) {
        //     totalAccruedProfit += accruedInterest;
        // } else if (creditInfo.state == CreditState.Delayed) {
        //     totalAccruedLoss += accruedPrincipalLoss;
        //     CreditConfig memory creditConfig = creditConfigs[creditHash];
        //     accruedInterest = _refreshCreditProfit(creditInfo, creditConfig);
        //     totalAccruedProfit += accruedInterest;
        // }
        // // update paid interest
        // uint256 interestPart = creditInfo.checkPoint.totalAccruedInterest -
        //     creditInfo.checkPoint.totalPaidInterest;
        // interestPart = amount > interestPart ? interestPart : amount;
        // creditInfo.checkPoint.totalPaidInterest += uint96(interestPart);
        // // update paid principal
        // uint256 remaining = amount - interestPart;
        // uint256 principalPart = creditInfo.checkPoint.totalAccruedPrincipal >
        //     creditInfo.checkPoint.totalPaidPrincipal
        //     ? creditInfo.checkPoint.totalAccruedPrincipal -
        //         creditInfo.checkPoint.totalPaidPrincipal
        //     : 0;
        // // :handle payoff
        // // :if payoff remove credit from active/overdue array and set recovered to true
        // bool fullPayment;
        // if (remaining >= principalPart) {
        //     // :if credit is overdue, move credit to active array
        //     fullPayment = true;
        // }
        // creditInfo.checkPoint.totalPaidPrincipal += uint96(remaining);
        // if (fullPayment) {
        //     // :generate next due info
        //     uint256 lossPart = creditInfo.checkPoint.totalAccruedLoss > totalAccruedLoss
        //         ? totalAccruedLoss
        //         : creditInfo.checkPoint.totalAccruedLoss;
        //     totalAccruedLoss -= lossPart;
        //     creditInfo.checkPoint.totalAccruedLoss -= uint96(lossPart);
        //     if (creditInfo.checkPoint.totalAccruedLoss > 0) {
        //         totalAccruedLossRecovery += creditInfo.checkPoint.totalAccruedLoss;
        //         creditInfo.checkPoint.totalAccruedLoss = 0;
        //     }
        // }
    }

    function refreshPnL() external returns (uint256 profit, uint256 loss, uint256 lossRecovery) {
        // profit = totalAccruedProfit;
        // loss = totalAccruedLoss;
        // lossRecovery = totalAccruedLossRecovery;
        // uint256 activeHashCount = activeCreditsHash.length;
        // uint256 overdueHashCount = overdueCreditsHash.length;
        // bytes32[] memory hashs = new bytes32[](activeHashCount + overdueHashCount);
        // for (uint256 i; i < activeHashCount; i++) {
        //     hashs[i] = activeCreditsHash[i];
        // }
        // for (uint256 i; i < overdueHashCount; i++) {
        //     hashs[activeHashCount + i] = overdueCreditsHash[i];
        // }
        // // Iterate all active credits to get the total profit
        // for (uint256 i; i < activeHashCount + overdueHashCount; i++) {
        //     bytes32 hash = hashs[i];
        //     CreditInfo memory creditInfo = credits[hash];
        //     (uint256 accruedInterest, uint256 accruedPrincipalLoss) = _refreshCredit(
        //         hash,
        //         creditInfo
        //     );
        //     credits[hash] = creditInfo;
        //     if (accruedInterest > 0) profit += accruedInterest;
        //     if (accruedPrincipalLoss > 0) loss += accruedPrincipalLoss;
        // }
        // if (loss >= lossRecovery) {
        //     loss -= lossRecovery;
        //     lossRecovery = 0;
        // } else {
        //     lossRecovery -= loss;
        //     loss = 0;
        // }
        // totalAccruedProfit = 0;
        // totalAccruedLoss = 0;
        // totalAccruedLossRecovery = 0;
    }

    function currentPnL()
        external
        view
        returns (uint256 profit, uint256 loss, uint256 lossRecovery)
    {
        // profit = totalAccruedProfit;
        // loss = totalAccruedLoss;
        // lossRecovery = totalAccruedLossRecovery;
        // uint256 activeHashCount = activeCreditsHash.length;
        // uint256 overdueHashCount = overdueCreditsHash.length;
        // bytes32[] memory hashs = new bytes32[](activeHashCount + overdueHashCount);
        // for (uint256 i; i < activeHashCount; i++) {
        //     hashs[i] = activeCreditsHash[i];
        // }
        // for (uint256 i; i < overdueHashCount; i++) {
        //     hashs[activeHashCount + i] = overdueCreditsHash[i];
        // }
        // // Iterate all active credits to get the total profit
        // for (uint256 i; i < activeHashCount + overdueHashCount; i++) {
        //     bytes32 hash = activeCreditsHash[i];
        //     CreditInfo memory creditInfo = credits[hash];
        //     (uint256 accruedInterest, uint256 accruedPrincipalLoss) = _refreshCredit(
        //         hash,
        //         creditInfo
        //     );
        //     if (accruedInterest > 0) profit += accruedInterest;
        //     if (accruedPrincipalLoss > 0) loss += accruedPrincipalLoss;
        // }
        // if (loss >= lossRecovery) {
        //     loss -= lossRecovery;
        //     lossRecovery = 0;
        // } else {
        //     lossRecovery -= loss;
        //     loss = 0;
        // }
    }

    function _isOverdue(uint256 dueDate) internal view returns (bool) {}

    // todo provide an external view function for credit payment due list ?

    function updateYield(address borrower, uint yieldInBps) external {}

    function refreshPnL(
        bytes32 creditHash
    ) external returns (uint256 profit, uint256 loss, uint256 lossRecovery) {}

    function pauseCredit() external {}

    function unpauseCredit() external {}

    function _updatePnl(
        uint256 principalPaid,
        uint256 yieldPaid,
        uint256 feesPaid,
        uint256 yield
    ) internal {
        PnLTracker memory _tempPnlTracker = pnlTracker;
        _tempPnlTracker.totalProfit += uint96(feesPaid);
        _tempPnlTracker.totalProfit += uint96(
            _tempPnlTracker.profitRate * uint64((block.timestamp - _tempPnlTracker.pnlLastUpdated))
        );
        _tempPnlTracker.profitRate -= uint96(
            (principalPaid * yield) / HUNDRED_PERCENT_IN_BPS / SECONDS_IN_A_YEAR
        );
        _tempPnlTracker.pnlLastUpdated = uint64(block.timestamp);
        pnlTracker = _tempPnlTracker;

        // todo handle lossRecovery
    }

    /**
     * @notice Distributes income to token holders.
     */
    function distributeIncome(uint256 value) internal virtual returns (uint256 poolIncome) {
        // uint256 poolIncome = _poolConfig.distributeIncome(value);
        // _totalPoolValue += poolIncome;
    }
}
