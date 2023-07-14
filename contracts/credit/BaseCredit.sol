// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, CreditProfit, CreditLoss, CreditState, LimitAndCommitment} from "./CreditStructs.sol";
import {ICreditFeeManager} from "./utils/interfaces/ICreditFeeManager.sol";
import {ICredit} from "./interfaces/ICredit.sol";
import {BaseCreditStorage} from "./BaseCreditStorage.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {HumaConfig} from "../HumaConfig.sol";
import {CalendarUnit} from "../SharedDefs.sol";

/**
 * @notice BaseCredit is the basic form of a credit.
 */

// todo to remove this struct.
struct CreditLimit {
    address borrower; // loan borrower address
    uint96 creditLimit; // the max borrowed amount
}

/// Key capabilities to be added: profilt & loss, credit-level action vs. wallet-level
/// Credit limit: credit-level limit & borrower-level
/// Design consideration:
/// 1. separate lastUpdateDate for profit and loss
/// 2. Refresh profit and loss by using an IProfitLossRefersher.
/// approve, drawdown, makePayment, updateCreditLine, closeCreditLine
/// refreshProfitAndLoss
contract BaseCredit is BaseCreditStorage, ICredit {
    ICreditFeeManager _feeManager;

    enum CreditLineClosureReason {
        Paidoff,
        CreditLimitChangedToBeZero,
        OverwrittenByNewLine
    }

    /// Account billing info refreshed with the updated due amount and date
    event BillRefreshed(address indexed borrower, uint256 newDueDate, address by);
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
     * @notice Change the limit at the borrower level.
     * @param borrower the borrower address
     * @param creditLimit the credit limit at the borrower level
     * @param committed the amount the borrower committed to use. If the borrowed amount is less than
     * the committed amount, the yield will be computed using committed amount.
     */
    function setBorrowerLimit(
        address borrower,
        uint96 creditLimit,
        uint96 committed
    ) public virtual {
        _protocolAndPoolOn();
        onlyEAServiceAccount();

        LimitAndCommitment memory lc = LimitAndCommitment(creditLimit, committed);
        _borrowerLimitMap[borrower] = lc;

        // :emit BorrowerCreditLimitUpdatedApproved(borrower, creditLimit);
    }

    /**
     * @notice Approves the credit request with the terms provided.
     * @param creditHash the hash of the credit
     * @param creditLimit the credit limit of the credit line
     * @param calendarUnit how the period is measured, by days or by semimonth
     * @param payPeriodInCalendarUnit the multiple of the calendarUnit
     * @param remainingPeriods how many cycles are there before the credit line expires
     * @param apyInBps expected yield expressed in basis points, 1% is 100, 100% is 10000
     * @dev only Evaluation Agent can call
     */
    function approveCredit(
        bytes32 creditHash,
        address borrower,
        uint256 creditLimit,
        uint256 calendarUnit,
        uint256 payPeriodInCalendarUnit,
        uint256 remainingPeriods,
        uint256 apyInBps,
        bool revolving
    ) internal virtual {
        _protocolAndPoolOn();
        onlyEAServiceAccount();
        if (calendarUnit > 2) revert Errors.invalidCalendarUnit();
        if (payPeriodInCalendarUnit == 0) revert Errors.requestedCreditWithZeroDuration();
        if (remainingPeriods == 0) revert Errors.zeroPayPeriods();

        // :Need to check both are credit level and borrower level
        _maxCreditLineCheck(creditLimit);

        // We allow credit approval to be updated only if there is no drawdown happened
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (cr.state >= CreditState.Approved) revert Errors.creditLineNotInStateForUpdate();

        CreditConfig memory cc = _getCreditConfig(creditHash);
        cc.calendarUnit = CalendarUnit(calendarUnit);
        cc.periodDuration = uint8(payPeriodInCalendarUnit);
        cc.numOfPeriods = uint16(remainingPeriods);
        cc.apyInBps = uint16(apyInBps);
        cc.revolving = revolving;
        cc.creditLimit = uint96(creditLimit);
        cc.borrower = borrower;

        _setCreditConfig(creditHash, cc);

        // :emit CreditApproved(borrower, creditLimit, intervalInDays, remainingPeriods, aprInBps);
    }

    function closeCredit(bytes32 creditHash) public virtual {
        // :only borrower or EA
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (cr.totalDue != 0 || cr.unbilledPrincipal != 0) {
            revert Errors.creditLineHasOutstandingBalance();
        }
        // :revert if the pool the pool requires committed loan
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
     * @param creditHash the owner of the credit line
     * @param newCreditLimit the new limit of the line in the unit of pool token
     * @dev The credit line is marked as Deleted if 1) the new credit line is 0 AND
     * 2) there is no due or unbilled principals.
     * @dev only Evaluation Agent can call
     */
    function updateCreditLimit(bytes32 creditHash, uint96 newCreditLimit) public virtual {
        _protocolAndPoolOn();
        onlyEAServiceAccount();
        // Borrowing amount needs to be lower than max for the pool.
        _maxCreditLineCheck(newCreditLimit);
        _creditConfigMap[creditHash].creditLimit = newCreditLimit;

        // Delete the credit record if the new limit is 0 and no outstanding balance
        if (newCreditLimit == 0) {
            CreditRecord memory cr = _creditRecordMap[creditHash];
            if (cr.unbilledPrincipal == 0 && cr.totalDue == 0) {
                cr.state == CreditState.Deleted;
            }
        }

        // emit CreditLineChanged(borrower, oldCreditLimit, newCreditLimit);
    }

    /**
     * @notice allows the borrower to borrow against an approved credit line.
     * The borrower can borrow and pay back as many times as they would like.
     * @param borrowAmount the amount to borrow
     */
    function drawdown(bytes32 creditHash, uint256 borrowAmount) external virtual override {
        address borrower = msg.sender;
        // Open access to the borrower
        if (borrowAmount == 0) revert Errors.zeroAmountProvided();
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (borrower != cr.borrower) revert Errors.notBorrower();

        // _checkDrawdownEligibility(cr, borrowAmount);
        // uint256 netAmountToBorrower = _drawdown(borrower, cr, borrowAmount);
        // emit DrawdownMade(borrower, borrowAmount, netAmountToBorrower);
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
        _updateDueInfo(creditHash, false);
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
        // if (msg.sender != borrower) onlyPDSServiceAccount();
        // (amountPaid, paidoff, ) = _makePayment(borrower, amount, BS.PaymentStatus.NotReceived);
        // CreditLimit memory creditLimit = creditLimits[creditHash];
        // _payToCredit(creditHash, amount);
        // // transfer amount from msg.sender
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
            return _updateDueInfo(creditHash, false);
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
     * @dev the requester can be the borrower or the EA
     * @dev requires the credit line to be in Approved (first drawdown) or
     * Good Standing (return drawdown) state.
     * @dev for first drawdown, after the credit line is approved, it needs to happen within
     * the expiration window configured by the pool
     * @dev the drawdown should not put the account over the approved credit limit
     * @dev Please note cr.nextDueDate is the credit expiration date for the first drawdown.
     */
    function _checkDrawdownEligibility(
        bytes32 creditHash,
        CreditRecord memory cr,
        uint256 borrowAmount
    ) internal view {
        _protocolAndPoolOn();

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

            if (borrowAmount > _creditConfigMap[creditHash].creditLimit)
                revert Errors.creditLineExceeded();
        }
    }

    /**
     * @notice helper function for drawdown
     * @param creditHash the credit hash
     * @param borrowAmount the amount to borrow
     */
    function _drawdown(
        bytes32 creditHash,
        CreditRecord memory cr,
        uint256 borrowAmount
    ) internal virtual returns (uint256) {
        if (cr.state == CreditState.Approved) {
            // Flow for first drawdown
            // Update total principal
            _creditRecordMap[creditHash].unbilledPrincipal = uint96(borrowAmount);
            // Generates the first bill
            // Note: the interest is calculated at the beginning of each pay period
            cr = _updateDueInfo(creditHash, true);
            // Set account status in good standing
            cr.state = CreditState.GoodStanding;
        } else {
            // Return drawdown flow
            // Bring the account current.
            if (block.timestamp > cr.nextDueDate) {
                cr = _updateDueInfo(creditHash, false);
                if (cr.state != CreditState.GoodStanding)
                    revert Errors.creditLineNotInGoodStandingState();
            }
            // todo fix to check against credit limit
            // if (
            //     borrowAmount >
            //     (_creditRecordStaticMap[borrower].creditLimit -
            //         cr.unbilledPrincipal -
            //         (cr.totalDue - cr.feesAndInterestDue))
            // ) revert Errors.creditLineExceeded();
            // note Drawdown is not allowed in the final pay period since the payment due for
            // such drawdown will fall outside of the window of the credit line.
            // note since we bill at the beginning of a period, cr.remainingPeriods is zero
            // in the final period.
            if (cr.remainingPeriods == 0) revert Errors.creditExpiredDueToMaturity();
            // For non-first bill, we do not update the current bill, the interest for the rest of
            // this pay period is accrued in correction and will be added to the next bill.
            cr.unbilledPrincipal = uint96(cr.unbilledPrincipal + borrowAmount);
        }
        _setCreditRecord(creditHash, cr);
        (uint256 netAmountToBorrower, uint256 platformFees) = _feeManager.distBorrowingAmount(
            borrowAmount
        );
        // todo add distributeIncome function
        // if (platformFees > 0) distributeIncome(platformFees);
        // Transfer funds to the _borrower
        // todo transfer.
        //_underlyingToken.safeTransfer(borrower, netAmountToBorrower);
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
     * @param borrower the address of the borrower
     * @param amount the payment amount
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indciating whether the account has been paid off.
     * @return isReviewRequired a flag indicating whether this payment transaction has been
     * flagged for review.
     */
    function _makePayment(
        address borrower,
        uint256 amount
    ) internal returns (uint256 amountPaid, bool paidoff, bool isReviewRequired) {
        _protocolAndPoolOn();

        // if (amount == 0) revert Errors.zeroAmountProvided();

        // CreditRecord memory cr = _getCreditRecord(borrower);

        // if (
        //     cr.state == BS.CreditState.Requested ||
        //     cr.state == BS.CreditState.Approved ||
        //     cr.state == BS.CreditState.Deleted
        // ) {
        //     if (paymentStatus == BS.PaymentStatus.NotReceived)
        //         revert Errors.creditLineNotInStateForMakingPayment();
        //     else if (paymentStatus == BS.PaymentStatus.ReceivedNotVerified)
        //         return (0, false, true);
        // }

        // if (block.timestamp > cr.nextDueDate) {
        //     // Bring the account current. This is necessary since the account might have been dormant for
        //     // several cycles.
        //     cr = _updateDueInfo(borrower, false, true);
        // }

        // // Computes the final payoff amount. Needs to consider the correction associated with
        // // all outstanding principals.
        // uint256 payoffCorrection = _calcCorrection(
        //     cr.nextDueDate,
        //     _creditRecordStaticMap[borrower].aprInBps,
        //     cr.unbilledPrincipal + cr.totalDue - cr.feesAndInterestDue
        // );

        // uint256 payoffAmount = uint256(
        //     int256(int96(cr.totalDue + cr.unbilledPrincipal)) + int256(cr.correction)
        // ) - payoffCorrection;

        // // If the reported received payment amount is far higher than the invoice amount,
        // // flags the transaction for review.
        // if (paymentStatus == BS.PaymentStatus.ReceivedNotVerified) {
        //     // Check against in-memory payoff amount first is purely for gas consideration.
        //     // We expect near 100% of the payments to fail in the first check
        //     if (amount > REVIEW_MULTIPLIER * payoffAmount) {
        //         if (
        //             amount >
        //             REVIEW_MULTIPLIER * uint256(_getCreditRecordStatic(borrower).creditLimit)
        //         ) return (0, false, true);
        //     }
        // }

        // // The amount to be collected from the borrower. When _amount is more than what is needed
        // // for payoff, only the payoff amount will be transferred
        // uint256 amountToCollect;

        // // The amount to be applied towards principal
        // uint256 principalPayment = 0;

        // if (amount < payoffAmount) {
        //     if (amount < cr.totalDue) {
        //         amountToCollect = amount;
        //         cr.totalDue = uint96(cr.totalDue - amount);

        //         if (amount <= cr.feesAndInterestDue) {
        //             cr.feesAndInterestDue = uint96(cr.feesAndInterestDue - amount);
        //         } else {
        //             principalPayment = amount - cr.feesAndInterestDue;
        //             cr.feesAndInterestDue = 0;
        //         }
        //     } else {
        //         amountToCollect = amount;

        //         // Apply extra payments towards principal, reduce unbilledPrincipal amount
        //         cr.unbilledPrincipal -= uint96(amount - cr.totalDue);

        //         principalPayment = amount - cr.feesAndInterestDue;
        //         cr.totalDue = 0;
        //         cr.feesAndInterestDue = 0;
        //         cr.missedPeriods = 0;

        //         // Moves account to GoodStanding if it was delayed.
        //         if (cr.state == BS.CreditState.Delayed) cr.state = BS.CreditState.GoodStanding;
        //     }

        //     // Gets the correction.
        //     if (principalPayment > 0) {
        //         // If there is principal payment, calculate new correction
        //         cr.correction -= int96(
        //             uint96(
        //                 _calcCorrection(
        //                     cr.nextDueDate,
        //                     _creditRecordStaticMap[borrower].aprInBps,
        //                     principalPayment
        //                 )
        //             )
        //         );
        //     }

        //     // Recovers funds to the pool if the account is Defaulted.
        //     // Only moves it to GoodStanding only after payoff, handled in the payoff branch
        //     if (cr.state == BS.CreditState.Defaulted)
        //         _recoverDefaultedAmount(borrower, amountToCollect);
        // } else {
        //     // Payoff logic
        //     principalPayment = cr.unbilledPrincipal + cr.totalDue - cr.feesAndInterestDue;
        //     amountToCollect = payoffAmount;

        //     if (cr.state == BS.CreditState.Defaulted) {
        //         _recoverDefaultedAmount(borrower, amountToCollect);
        //     } else {
        //         // Distribut or reverse income to consume outstanding correction.
        //         // Positive correction is generated because of a drawdown within this period.
        //         // It is not booked or distributed yet, needs to be distributed.
        //         // Negative correction is generated because of a payment including principal
        //         // within this period. The extra interest paid is not accounted for yet, thus
        //         // a reversal.
        //         // Note: For defaulted account, we do not distribute fees and interests
        //         // until they are paid. It is handled in _recoverDefaultedAmount().
        //         cr.correction = cr.correction - int96(int256(payoffCorrection));
        //         if (cr.correction > 0) distributeIncome(uint256(uint96(cr.correction)));
        //         else if (cr.correction < 0) reverseIncome(uint256(uint96(0 - cr.correction)));
        //     }

        //     cr.correction = 0;
        //     cr.unbilledPrincipal = 0;
        //     cr.feesAndInterestDue = 0;
        //     cr.totalDue = 0;
        //     cr.missedPeriods = 0;

        //     // Closes the credit line if it is in the final period
        //     if (cr.remainingPeriods == 0) {
        //         cr.state = BS.CreditState.Deleted;
        //         emit CreditLineClosed(borrower, msg.sender, CreditLineClosureReason.Paidoff);
        //     } else cr.state = BS.CreditState.GoodStanding;
        // }

        // _setCreditRecord(borrower, cr);

        // if (amountToCollect > 0 && paymentStatus == BS.PaymentStatus.NotReceived) {
        //     // Transfer assets from the _borrower to pool locker
        //     _underlyingToken.safeTransferFrom(borrower, address(this), amountToCollect);
        //     emit PaymentMade(
        //         borrower,
        //         amountToCollect,
        //         cr.totalDue,
        //         cr.unbilledPrincipal,
        //         msg.sender
        //     );
        // }

        // // amountToCollect == payoffAmount indicates whether it is paid off or not.
        // // Use >= as a safe practice
        // return (amountToCollect, amountToCollect >= payoffAmount, false);
    }

    /**
     * @notice Recovers amount when a payment is paid towards a defaulted account.
     * @dev For any payment after a default, it is applied towards principal losses first.
     * Only after the principal is fully recovered, it is applied towards fees & interest.
     */
    function _recoverDefaultedAmount(address borrower, uint256 amountToCollect) internal {
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
     * @notice updates CreditRecord for `_borrower` using the most up to date information.
     * @dev this is used in both makePayment() and drawdown() to bring the account current
     * @dev getDueInfo() gets the due information of the most current cycle. This function
     * updates the record in creditRecordMap for `_borrower`
     * @param creditHash the hash of the credit
     * @param isFirstDrawdown whether this request is for the first drawdown of the credit line
     */
    function _updateDueInfo(
        bytes32 creditHash,
        bool isFirstDrawdown
    ) internal virtual returns (CreditRecord memory cr) {
        // cr = _getCreditRecord(creditHash);
        // if (isFirstDrawdown) cr.nextDueDate = 0;
        // bool alreadyLate = cr.totalDue > 0 ? true : false;
        // // Gets the up-to-date due information for the borrower. If the account has been
        // // late or dormant for multiple cycles, getDueInfo() will bring it current and
        // // return the most up-to-date due information.
        // uint256 periodsPassed = 0;
        // int96 newCharges;
        // (
        //     periodsPassed,
        //     cr.feesAndInterestDue,
        //     cr.totalDue,
        //     cr.unbilledPrincipal,
        //     newCharges
        // ) = _feeManager.getDueInfo(cr, _getCreditRecordStatic(borrower));
        // if (periodsPassed > 0) {
        //     cr.correction = 0;
        //     // Distribute income
        //     if (cr.state != BS.CreditState.Defaulted) {
        //         if (!distributeChargesForLastCycle)
        //             newCharges = newCharges - int96(cr.feesAndInterestDue);
        //         if (newCharges > 0) distributeIncome(uint256(uint96(newCharges)));
        //         else if (newCharges < 0) reverseIncome(uint256(uint96(0 - newCharges)));
        //     }
        //     uint16 intervalInDays = _creditRecordStaticMap[borrower].intervalInDays;
        //     if (cr.nextDueDate > 0)
        //         cr.nextDueDate = uint64(
        //             cr.nextDueDate + periodsPassed * intervalInDays * SECONDS_IN_A_DAY
        //         );
        //     else cr.nextDueDate = uint64(block.timestamp + intervalInDays * SECONDS_IN_A_DAY);
        //     // Adjusts remainingPeriods, special handling when reached the maturity of the credit line
        //     if (cr.remainingPeriods > periodsPassed) {
        //         cr.remainingPeriods = uint16(cr.remainingPeriods - periodsPassed);
        //     } else {
        //         cr.remainingPeriods = 0;
        //     }
        //     // Sets the right missedPeriods and state for the credit record
        //     if (alreadyLate) cr.missedPeriods = uint16(cr.missedPeriods + periodsPassed);
        //     else cr.missedPeriods = 0;
        //     if (cr.missedPeriods > 0) {
        //         if (cr.state != BS.CreditState.Defaulted) cr.state = BS.CreditState.Delayed;
        //     } else cr.state = BS.CreditState.GoodStanding;
        //     _setCreditRecord(borrower, cr);
        //     emit BillRefreshed(borrower, cr.nextDueDate, msg.sender);
        // }
    }

    /// Shared setter to the credit record mapping for contract size consideration
    function _setCreditRecord(bytes32 creditHash, CreditRecord memory cr) internal {
        _creditRecordMap[creditHash] = cr;
    }

    /// Shared accessor to the credit record mapping for contract size consideration
    function _getCreditRecord(bytes32 creditHash) internal view returns (CreditRecord memory) {
        return _creditRecordMap[creditHash];
    }

    /// Shared accessor to the credit record static mapping for contract size consideration
    function _getCreditConfig(bytes32 creditHash) internal view returns (CreditConfig memory cc) {
        return _creditConfigMap[creditHash];
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

    function _refreshCreditProfit(
        CreditRecord memory creditRecord,
        CreditConfig memory creditConfig
    ) internal view returns (uint256 accruedInterest) {
        // (uint256 accruedInterest, uint256 accruedPrincipal) = feeManager.accruedDebt(
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
}
