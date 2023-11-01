// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "../Errors.sol";
import {HumaConfig} from "../HumaConfig.sol";
import {PoolConfig, PoolSettings} from "../PoolConfig.sol";
import {PoolConfigCache} from "../PoolConfigCache.sol";
import {CreditStorage} from "./CreditStorage.sol";
import {CreditConfig, CreditRecord, CreditLimit, CreditLoss, CreditState, DueDetail, CreditLoss} from "./CreditStructs.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {IFirstLossCover} from "../interfaces/IFirstLossCover.sol";
import {IPoolSafe} from "../interfaces/IPoolSafe.sol";
import {ICreditFeeManager} from "./utils/interfaces/ICreditFeeManager.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {BORROWER_FIRST_LOSS_COVER_INDEX, DAYS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS, SECONDS_IN_A_DAY} from "../SharedDefs.sol";

/**
 * Credit is the core borrowing concept in Huma Protocol. This abstract contract provides
 * basic operations that applies to all credits in Huma Protocol.
 */
abstract contract Credit is Initializable, PoolConfigCache, CreditStorage {
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
    event RemainingPeriodsExtended(
        bytes32 indexed creditHash,
        uint256 numOfPeriods,
        uint256 remainingPeriods,
        address by
    );
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
     * @param nextDueDate the due date of the next payment
     * @param nextDue the amount due on the next payment of the credit line
     * @param totalPastDue the sum of lateFee + pastDue. See CreditStructs.DueDetail for more info
     * @param totalPastDuePaid the payment amount applied to past due
     * @param unbilledPrincipal the unbilled principal on the credit line after processing the payment
     * @param principalPaid the amount of this payment applied to principal
     * @param yieldPaid the amount of this payment applied to yield
     * @param by the address that has triggered the process of marking the payment made.
     * In most cases, it is the borrower. In receivable factoring, it is PDSServiceAccount.
     */
    event PaymentMade(
        address indexed borrower,
        uint256 amount,
        uint256 nextDueDate,
        uint256 nextDue,
        uint256 totalPastDue,
        uint256 unbilledPrincipal,
        uint256 principalPaid,
        uint256 yieldPaid,
        uint256 totalPastDuePaid,
        address by
    );
    /**
     * @notice A payment has been made against the credit line
     * @param borrower the address of the borrower
     * @param amount the payback amount
     * @param nextDueDate the due date of the next payment
     * @param nextDue the amount due on the next payment of the credit line
     * @param unbilledPrincipal the unbilled principal on the credit line after processing the payment
     * @param principalPaid the amount of this payment applied to principal
     * @param by the address that has triggered the process of marking the payment made.
     * In most cases, it is the borrower. In receivable factoring, it is PDSServiceAccount.
     */
    event PrincipalPaymentMade(
        address indexed borrower,
        uint256 amount,
        uint256 nextDueDate,
        uint256 nextDue,
        uint256 unbilledPrincipal,
        uint256 principalPaid,
        address by
    );

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
        _onlyEAServiceAccount();

        if (newAvailableCredit > poolConfig.getPoolSettings().maxCreditLine) {
            revert Errors.greaterThanMaxCreditLine();
        }
        if (newAvailableCredit > _creditConfigMap[creditHash].creditLimit) {
            revert Errors.greaterThanMaxCreditLine();
        }
        CreditLimit memory limit = _creditLimitMap[creditHash];
        limit.availableCredit = newAvailableCredit;
        _creditLimitMap[creditHash] = limit;

        // Delete the credit record if the new limit is 0 and no outstanding balance
        if (newAvailableCredit == 0) {
            CreditRecord memory cr = _getCreditRecord(creditHash);
            if (cr.unbilledPrincipal == 0 && cr.nextDue == 0) {
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
        //* Reserved for Richard review, to be deleted
        // It is for borrower, not very useful, does credit need this function?

        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();
        // Credit limit needs to be lower than max for the pool.
        if (newCreditLimit > poolConfig.getPoolSettings().maxCreditLine) {
            revert Errors.greaterThanMaxCreditLine();
        }
        CreditLimit memory limit = _borrowerLimitMap[borrower];
        limit.creditLimit = newCreditLimit;
        _borrowerLimitMap[borrower] = limit;

        // emit CreditLineChanged(borrower, oldCreditLimit, newCreditLimit);
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

    function isApproved(bytes32 creditHash) public view virtual returns (bool) {
        return ((_creditRecordMap[creditHash].state >= CreditState.Approved));
    }

    /**
     * @notice checks if the credit line is ready to be triggered as defaulted
     */
    function isDefaultReady(bytes32 creditHash) public view virtual returns (bool isDefault) {
        return _isDefaultReady(_getCreditRecord(creditHash));
    }

    function _isDefaultReady(CreditRecord memory cr) internal view returns (bool isDefault) {
        PoolSettings memory settings = poolConfig.getPoolSettings();
        return
            cr.missedPeriods > 1 &&
            (cr.missedPeriods - 1) * settings.payPeriodInMonths >=
            settings.defaultGracePeriodInMonths;
    }

    /**
     * @notice checks if the credit line is behind in payments
     * @dev When the account is in Approved state, there is no borrowing yet, thus being late
     * does not apply. Thus the check on account state.
     * @dev After the bill is refreshed, the due date is updated, it is possible that the new due
     * date is in the future, but if the bill refresh has set missedPeriods, the account is late.
     */
    function isLate(bytes32 creditHash) public view virtual returns (bool lateFlag) {
        CreditRecord memory cr = _getCreditRecord(creditHash);
        return (cr.state > CreditState.Approved &&
            (cr.missedPeriods > 0 || block.timestamp > cr.nextDueDate));
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
        // TODO if (creditHash == bytes32(0)) revert Errors.zeroAddressProvided(); ？
        if (creditLimit == 0) revert Errors.zeroAmountProvided();
        if (remainingPeriods == 0) revert Errors.zeroPayPeriods();
        // TODO if (yieldInBps == 0) revert Errors.zeroAmountProvided(); ？
        // TODO if (committedAmount == 0) revert Errors.zeroAmountProvided(); ？
        if (committedAmount > creditLimit) revert Errors.committedAmountGreaterThanCreditLimit();

        PoolSettings memory ps = poolConfig.getPoolSettings();
        if (creditLimit > ps.maxCreditLine) {
            revert Errors.greaterThanMaxCreditLine();
        }

        // Before a drawdown happens, it is allowed to re-approve a credit to change the terms.
        // Once a drawdown has happened, it is disallowed to re-approve a credit. One has call
        // other functions to change the terms of the credit.
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (cr.state >= CreditState.Approved) revert Errors.creditLineNotInStateForUpdate();

        CreditConfig memory cc = _getCreditConfig(creditHash);
        cc.creditLimit = uint96(creditLimit);
        cc.committedAmount = committedAmount;
        cc.periodDuration = ps.payPeriodInMonths;
        cc.numOfPeriods = uint16(remainingPeriods);
        cc.yieldInBps = uint16(yieldInBps);
        cc.revolving = revolving;
        _setCreditConfig(creditHash, cc);
        emit CreditConfigChanged(
            creditHash,
            cc.creditLimit,
            cc.committedAmount,
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
        // TODO: is the compromise described below still applicable?
        // Decided to use this field in this way to save one field for the struct.
        // Although we have room in the struct after split struct creditRecord and
        // struct CreditConfig, we keep it unchanged to leave room for the struct
        // to expand in the future (note Solidity has limit on 13 fields in a struct)
        if (ps.creditApprovalExpirationInDays > 0)
            cr.nextDueDate = uint64(
                block.timestamp + ps.creditApprovalExpirationInDays * SECONDS_IN_A_DAY
            );
        cr.remainingPeriods = remainingPeriods;
        cr.state = CreditState.Approved;
        _setCreditRecord(creditHash, cr);

        _creditBorrowerMap[creditHash] = borrower;
    }

    /**
     * @notice Closes a credit record.
     * @dev Only the borrower or EA Service account can call this function
     * @dev Revert if there is still balance due
     * @dev Revert if the committed amount is non-zero and there are periods remaining
     */
    function _closeCredit(bytes32 creditHash) internal virtual {
        _onlyBorrowerOrEAServiceAccount(_creditBorrowerMap[creditHash]);

        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (cr.nextDue != 0 || cr.totalPastDue != 0 || cr.unbilledPrincipal != 0) {
            revert Errors.creditLineHasOutstandingBalance();
        }

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
        CreditRecord memory cr = _getCreditRecord(creditHash);
        CreditConfig memory cc = _getCreditConfig(creditHash);
        _checkDrawdownEligibility(borrower, cr, borrowAmount, cc.creditLimit);

        if (cr.state == CreditState.Approved) {
            // Flow for first drawdown
            // Sets the principal, then generates the first bill and sets credit status

            // todo need to handle middle of a period, particular, how to setup the final period
            // Note that we need to write to _creditRecordMap here directly rather than its copy `cr`
            // because `_updateDueInfo()` needs to access the updated `unbilledPrincipal` in storage.
            _creditRecordMap[creditHash].unbilledPrincipal = uint96(borrowAmount);
            cr = _updateDueInfo(creditHash);
            cr.state = CreditState.GoodStanding;
        } else {
            // Disallow repeated drawdown for non-revolving credit
            if (!cc.revolving) revert Errors.todo();

            // Bring the credit current and check if it is still in good standing.
            if (block.timestamp > cr.nextDueDate) {
                cr = _updateDueInfo(creditHash);
                if (cr.state != CreditState.GoodStanding)
                    revert Errors.creditLineNotInGoodStandingState();
            }

            // Note: drawdown is not allowed in the final pay period since the payment due for
            // such drawdown will fall outside of the window of the credit line.
            // Note that since we bill at the beginning of a period, cr.remainingPeriods is zero
            // in the final period.
            if (cr.remainingPeriods == 0) revert Errors.creditExpiredDueToMaturity();

            if (
                borrowAmount > (cc.creditLimit - cr.unbilledPrincipal - (cr.nextDue - cr.yieldDue))
            ) revert Errors.creditLineExceeded();

            // Add the yield of new borrowAmount for the remainder of the period
            (uint256 daysPassed, uint256 totalDays) = calendar.getDaysPassedInPeriod(
                cc.periodDuration
            );

            // It's important to note that the yield calculation includes the day of the drawdown. For instance,
            // if the borrower draws down at 11:59 PM on October 31st, the yield for October 31st must be paid,
            // hence the "+1" in the following calculation.
            uint256 additionalYield = (borrowAmount *
                cc.yieldInBps *
                (totalDays - daysPassed + 1)) / (DAYS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS);
            cr.yieldDue += uint96(additionalYield);
            cr.nextDue += uint96(additionalYield);
            cr.unbilledPrincipal = uint96(cr.unbilledPrincipal + borrowAmount);
        }
        _setCreditRecord(creditHash, cr);

        (uint256 netAmountToBorrower, uint256 platformProfit) = _feeManager.distBorrowingAmount(
            borrowAmount
        );

        //* todo call a new function of pool to distribute profit

        // Transfer funds to the borrower
        poolSafe.withdraw(borrower, netAmountToBorrower);
        emit DrawdownMade(borrower, borrowAmount, netAmountToBorrower);
    }

    /**
     * @notice Makes one payment. If the payment amount is equal to or higher
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

        CreditRecord memory cr = _updateDueInfo(creditHash);
        if (
            // TODO: do we still need the requested state?
            cr.state == CreditState.Requested ||
            cr.state == CreditState.Approved ||
            cr.state == CreditState.Deleted
        ) {
            revert Errors.creditLineNotInStateForMakingPayment();
        }

        CreditConfig memory cc = _getCreditConfig(creditHash);

        uint256 payoffAmount = _feeManager.getPayoffAmount(cr);
        uint256 amountToCollect = amount < payoffAmount ? amount : payoffAmount;
        uint256 principalPaid = 0;
        uint256 yieldPaid = 0;
        uint256 pastDuePaid = 0;

        if (amount < payoffAmount) {
            // Apply the payment to past due first.
            if (cr.totalPastDue > 0) {
                DueDetail memory dd = _getDueDetail(creditHash);
                if (amount > cr.totalPastDue) {
                    pastDuePaid = cr.totalPastDue;
                    amount -= cr.totalPastDue;
                    dd.lateFee = 0;
                    dd.pastDue = 0;
                    cr.totalPastDue = 0;
                } else {
                    // If the payment is not enough to cover the total amount past due, then
                    // apply the payment to the yield past due first, then late fees.
                    pastDuePaid = amount;
                    if (amount > dd.pastDue) {
                        dd.lateFee -= uint96(amount - dd.pastDue);
                        dd.pastDue = 0;
                    } else {
                        dd.pastDue -= uint96(amount);
                    }
                    cr.totalPastDue -= uint96(amount);
                    amount = 0;
                }
                dd.lateFeeUpdatedDate = uint64(calendar.getStartOfToday());
                _setDueDetail(creditHash, dd);
            }
            // Apply the remaining payment amount (if any) to next due.
            if (amount > 0) {
                // Apply the remaining payment amount (if any) to next due.
                if (amount < cr.nextDue) {
                    uint256 principalDue = cr.nextDue - cr.yieldDue;
                    // Apply the payment to yield due first, then principal due.
                    yieldPaid = amount < cr.yieldDue ? amount : cr.yieldDue;
                    cr.yieldDue -= uint96(yieldPaid);
                    principalPaid = amount - yieldPaid;
                    cr.nextDue = uint96(cr.nextDue - amount);

                    _setCreditRecord(creditHash, cr);
                } else {
                    // Apply extra payments towards principal, reduce unbilledPrincipal amount
                    principalPaid = amount - cr.yieldDue;
                    yieldPaid = cr.yieldDue;
                    cr.unbilledPrincipal -= uint96(amount - cr.nextDue);
                    cr.nextDue = 0;
                    cr.yieldDue = 0;
                    cr.missedPeriods = 0;
                    // Moves account to GoodStanding if it was delayed.
                    if (cr.state == CreditState.Delayed) cr.state = CreditState.GoodStanding;

                    _setCreditRecord(creditHash, cr);
                }
            }
        } else {
            // Payoff
            principalPaid = cr.unbilledPrincipal + cr.nextDue - cr.yieldDue;
            yieldPaid = payoffAmount - principalPaid;
            cr.unbilledPrincipal = 0;
            cr.yieldDue = 0;
            cr.nextDue = 0;
            cr.missedPeriods = 0;
            // Closes the credit line if it is in the final period
            if (cr.remainingPeriods == 0) {
                cr.state = CreditState.Deleted;
                emit CreditLineClosed(borrower, msg.sender, CreditLineClosureReason.Paidoff);
            } else cr.state = CreditState.GoodStanding;

            _setCreditRecord(creditHash, cr);
        }

        assert(amountToCollect > 0);
        poolSafe.deposit(msg.sender, amountToCollect);
        emit PaymentMade(
            borrower,
            amountToCollect,
            cr.nextDueDate,
            cr.nextDue,
            cr.totalPastDue,
            cr.unbilledPrincipal,
            principalPaid,
            yieldPaid,
            pastDuePaid,
            msg.sender
        );

        // amountToCollect == payoffAmount indicates payoff or not. >= is a safe practice
        return (amountToCollect, amountToCollect >= payoffAmount, false);
    }

    /**
     * @notice Borrower makes principal payment. The payment is applied towards principal only.
     * @param creditHash the hashcode of the credit
     * @param amount the payment amount
     * @return amountPaid the actual amount paid to the contract. When the tendered
     * amount is larger than the payoff amount, the contract only accepts the payoff amount.
     * @return paidoff a flag indicating whether the account has been paid off.
     */
    function _makePrincipalPayment(
        address borrower,
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountPaid, bool paidoff) {
        if (amount == 0) revert Errors.zeroAmountProvided();

        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (
            // TODO: do we need the requested state?
            cr.state == CreditState.Requested ||
            cr.state == CreditState.Approved ||
            cr.state == CreditState.Deleted
        ) {
            revert Errors.creditLineNotInStateForMakingPayment();
        }

        if (block.timestamp > cr.nextDueDate) {
            cr = _updateDueInfo(creditHash);
        }

        uint256 principalDue = cr.nextDue - cr.yieldDue;
        uint256 totalPrincipal = principalDue + cr.unbilledPrincipal;

        uint256 amountToCollect = amount < totalPrincipal ? amount : totalPrincipal;

        if (amount < principalDue) {
            cr.nextDue = uint96(cr.nextDue - amount);
        } else {
            // Payoff the principal due, then apply the remainder of the payment to reduce unbilled principal.
            cr.nextDue = uint96(cr.nextDue - principalDue);
            cr.unbilledPrincipal = uint96(cr.unbilledPrincipal - (amountToCollect - principalDue));
        }

        // Adjust credit record status if needed. This happens when the yieldDue happens to be 0.
        if (cr.nextDue == 0) {
            if (cr.unbilledPrincipal == 0 && cr.remainingPeriods == 0) {
                cr.state = CreditState.Deleted;
                emit CreditLineClosed(borrower, msg.sender, CreditLineClosureReason.Paidoff);
            } else cr.state = CreditState.GoodStanding;
        }

        assert(amountToCollect > 0);
        poolSafe.deposit(msg.sender, amountToCollect);
        emit PrincipalPaymentMade(
            borrower,
            amountToCollect,
            cr.nextDueDate,
            cr.nextDue,
            cr.unbilledPrincipal,
            amountToCollect,
            msg.sender
        );

        // The credit is paid off if there no next due or past due.
        return (amountToCollect, cr.nextDue == 0 && cr.totalPastDue == 0);
    }

    function _pauseCredit(bytes32 creditHash) internal {
        _onlyEAServiceAccount();
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
     * distributing the income for the upcoming period. Otherwise, update and distribute income.
     * Note the reason that we do not distribute income in the final cycle anymore since
     * it does not make sense to distribute income that we know cannot be collected to the
     * administrators (e.g. protocol, pool owner and EA) since it will only add more losses
     * to the LPs. Unfortunately, this special business consideration added more complexity
     * and cognitive load to `_updateDueInfo`.
     */
    function _refreshCredit(bytes32 creditHash) internal returns (CreditRecord memory cr) {
        if (_creditRecordMap[creditHash].state != CreditState.Defaulted) {
            return _updateDueInfo(creditHash);
        }
    }

    /// Shared setter to the credit config mapping
    function _setCreditConfig(bytes32 creditHash, CreditConfig memory cc) internal {
        _creditConfigMap[creditHash] = cc;
    }

    /// Shared setter to the credit record mapping for contract size consideration
    function _setCreditRecord(bytes32 creditHash, CreditRecord memory cr) internal {
        _creditRecordMap[creditHash] = cr;
    }

    /// Shared setter to the DueDetail mapping for contract size consideration
    function _setDueDetail(bytes32 creditHash, DueDetail memory dd) internal {
        _dueDetailMap[creditHash] = dd;
    }

    /// Shared setter to the CreditLoss mapping for contract size consideration
    function _setCreditLoss(bytes32 creditHash, CreditLoss memory cl) internal {
        _creditLossMap[creditHash] = cl;
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
        CreditRecord memory cr = _getCreditRecord(creditHash);
        DueDetail memory dd = _getDueDetail(creditHash);
        if (cr.state == CreditState.Defaulted) revert Errors.defaultHasAlreadyBeenTriggered();

        if (block.timestamp > cr.nextDueDate) {
            cr = _updateDueInfo(creditHash);
        }

        // Check if grace period has been exceeded. Please note that it takes a full pay period
        // before the account is considered to be late. The time passed should be one pay period
        // plus the grace period.
        if (!_isDefaultReady(cr)) revert Errors.defaultTriggeredTooEarly();

        // todo dd.pastDue could have principal in it, to get an accurate number, need to add a field to track it separately
        principalLoss = cr.unbilledPrincipal + cr.nextDue - cr.yieldDue;
        yieldLoss = cr.yieldDue + dd.pastDue;
        feesLoss = dd.lateFee;

        CreditLoss memory cl = _getCreditLoss(creditHash);
        cl.principalLoss += uint96(principalLoss);
        cl.yieldLoss += uint96(yieldLoss);
        cl.feesLoss += uint96(feesLoss);
        _setCreditLoss(creditHash, cl);

        //* todo call a new function of pool to distribute loss

        _creditRecordMap[creditHash].state = CreditState.Defaulted;
        emit DefaultTriggered(creditHash, principalLoss, yieldLoss, feesLoss, msg.sender);
    }

    function _unpauseCredit(bytes32 creditHash) internal virtual {
        _onlyEAServiceAccount();
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (cr.state == CreditState.Paused) {
            cr.state = CreditState.GoodStanding;
            _setCreditRecord(creditHash, cr);
        }
    }

    /**
     * @notice Updates CreditRecord for `creditHash` using the most up-to-date information.
     * @dev This function is used in several places to bring the account current whenever the caller
     * needs to work on the most up-to-date due information.
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

        // Get the up-to-date due information for the borrower. If the account has been
        // late or dormant for multiple cycles, getDueInfo() will bring it current and
        // return the most up-to-date due information.
        CreditConfig memory cc = _getCreditConfig(creditHash);
        DueDetail memory dd = _getDueDetail(creditHash);

        uint256 periodsPassed = 0;
        bool late;

        (cr, dd, periodsPassed, late) = _feeManager.getDueInfo(cr, cc, dd);

        if (periodsPassed > 0) {
            // Adjusts remainingPeriods. Sets remainingPeriods to 0 if the credit line has reached maturity.
            cr.remainingPeriods = cr.remainingPeriods > periodsPassed
                ? uint16(cr.remainingPeriods - periodsPassed)
                : 0;

            // Sets the correct missedPeriods. If nextDue is non-zero, the nextDue must be
            // non-zero for each of the passed period, thus add periodsPassed to cr.missedPeriods
            if (late) cr.missedPeriods = uint16(cr.missedPeriods + periodsPassed);
            else cr.missedPeriods = 0;

            if (cr.missedPeriods > 0) {
                if (cr.state != CreditState.Defaulted) {
                    cr.state = CreditState.Delayed;
                }
            } else cr.state = CreditState.GoodStanding;

            _setCreditRecord(creditHash, cr);
            _setDueDetail(creditHash, dd);

            emit BillRefreshed(creditHash, cr.nextDueDate, cr.nextDue);
        } else if (late) {
            _setDueDetail(creditHash, dd);
        }
    }

    function _updateYield(bytes32 creditHash, uint256 yieldInBps) internal virtual {
        CreditConfig memory cc = _getCreditConfig(creditHash);
        CreditRecord memory cr = _getCreditRecord(creditHash);
        DueDetail memory dd = _getDueDetail(creditHash);
        (uint256 daysPassed, uint256 totalDays) = calendar.getDaysPassedInPeriod(
            cc.periodDuration
        );
        uint256 principal = cr.unbilledPrincipal + cr.nextDue - cr.yieldDue;
        dd.accrued = uint96(
            ((daysPassed * cc.yieldInBps + (totalDays - daysPassed) * yieldInBps) * principal) /
                DAYS_IN_A_YEAR
        );
        uint256 updatedYieldDue = dd.committed > dd.accrued ? dd.committed : dd.accrued;
        cr.nextDue = uint96(cr.nextDue - cr.yieldDue + updatedYieldDue);
        cr.yieldDue = uint96(updatedYieldDue);
        _setCreditRecord(creditHash, cr);
        _setDueDetail(creditHash, dd);
        // TODO emit event. Need to report old bps, new bps, old yieldDue, new yieldDue
    }

    /**
     * @notice Checks if drawdown is allowed for the borrower at this point of time
     * @dev Checks to make sure the following conditions are met:
     * 1) The borrower has satisfied the first loss obligation
     * 2) The credit is in Approved or Goodstanding state
     * 3) For first time drawdown, the approval is not expired
     * 4) Drawdown amount is no more than available credit
     * @dev Please note cr.nextDueDate is the credit expiration date for the first drawdown.
     */
    function _checkDrawdownEligibility(
        address borrower,
        CreditRecord memory cr,
        uint256 borrowAmount,
        uint256 creditLimit
    ) internal view {
        if (!firstLossCover.isSufficient(borrower)) revert Errors.todo();

        if (cr.state != CreditState.GoodStanding && cr.state != CreditState.Approved)
            revert Errors.creditLineNotInStateForDrawdown();
        else if (cr.state == CreditState.Approved) {
            // After the credit approval, if the pool has credit expiration for the 1st drawdown,
            // the borrower must complete the first drawdown before the expiration date, which
            // is set in cr.nextDueDate in approveCredit().
            // Note: for pools without credit expiration for first drawdown, cr.nextDueDate is 0
            // before the first drawdown, thus the cr.nextDueDate > 0 condition in the check
            if (cr.nextDueDate > 0 && block.timestamp > cr.nextDueDate)
                revert Errors.creditExpiredDueToFirstDrawdownTooLate();

            if (borrowAmount > creditLimit) revert Errors.creditLineExceeded();
        }
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

    /// Shared accessor to DueDetail for contract size consideration
    function _getDueDetail(bytes32 creditHash) internal view returns (DueDetail memory) {
        return _dueDetailMap[creditHash];
    }

    /// Shared accessor to CreditLoss for contract size consideration
    function _getCreditLoss(bytes32 creditHash) internal view returns (CreditLoss memory) {
        return _creditLossMap[creditHash];
    }

    function _isOverdue(uint256 dueDate) internal view returns (bool) {}

    /// "Modifier" function that limits access to eaServiceAccount only
    function _onlyBorrowerOrEAServiceAccount(address borrower) internal view {
        if (msg.sender != borrower && msg.sender != _humaConfig.eaServiceAccount())
            revert Errors.evaluationAgentServiceAccountRequired();
    }

    /// "Modifier" function that limits access to eaServiceAccount only
    function _onlyEAServiceAccount() internal view {
        if (msg.sender != _humaConfig.eaServiceAccount())
            revert Errors.evaluationAgentServiceAccountRequired();
    }

    /// "Modifier" function that limits access to pdsServiceAccount only.
    function _onlyPDSServiceAccount() internal view {
        if (msg.sender != HumaConfig(_humaConfig).pdsServiceAccount())
            revert Errors.paymentDetectionServiceAccountRequired();
    }

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

        addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.getFirstLossCover(BORROWER_FIRST_LOSS_COVER_INDEX);
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        firstLossCover = IFirstLossCover(addr);
    }

    /**
     * @notice Extend the expiration (maturity) date of a credit
     * @param creditHash the hashcode of the credit
     * @param newNumOfPeriods the number of pay periods to be extended
     */
    function _extendRemainingPeriod(bytes32 creditHash, uint256 newNumOfPeriods) internal virtual {
        // Although not essential to call _updateDueInfo() to extend the credit line duration,
        // it is still a good practice to bring the account current while we update one of the fields.
        _updateDueInfo(creditHash);
        CreditRecord memory cr = _getCreditRecord(creditHash);
        uint256 oldNumOfPeriods = cr.remainingPeriods;
        cr.remainingPeriods += uint16(newNumOfPeriods);
        _creditRecordMap[creditHash] = cr;
        emit RemainingPeriodsExtended(
            creditHash,
            oldNumOfPeriods,
            cr.remainingPeriods,
            msg.sender
        );
    }

    function _waiveLateFee(
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountWaived) {
        CreditRecord memory cr = _getCreditRecord(creditHash);
        DueDetail memory dd = _getDueDetail(creditHash);
        amountWaived = amount > dd.lateFee ? dd.lateFee : amount;
        dd.lateFee -= uint96(amountWaived);
        cr.totalPastDue -= uint96(amountWaived);
        _setDueDetail(creditHash, dd);
        _setCreditRecord(creditHash, cr);
        return amountWaived;
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
    ) internal {
        CreditConfig memory cc = _getCreditConfig(creditHash);
        CreditRecord memory cr = _getCreditRecord(creditHash);
        DueDetail memory dd = _getDueDetail(creditHash);

        cc.creditLimit = uint96(creditLimit);
        cc.committedAmount = uint96(committedAmount);
        _setCreditConfig(creditHash, cc);

        (uint256 daysPassed, uint256 totalDays) = calendar.getDaysPassedInPeriod(
            cc.periodDuration
        );
        dd.committed = uint96(
            (daysPassed * cc.committedAmount + (totalDays - daysPassed) * committedAmount) *
                cc.yieldInBps
        );
        uint256 updatedYieldDue = dd.committed > dd.accrued ? dd.committed : dd.accrued;
        cr.nextDue = uint96(cr.nextDue - cr.yieldDue + updatedYieldDue);
        cr.yieldDue = uint96(updatedYieldDue);
        _setCreditRecord(creditHash, cr);
        _setDueDetail(creditHash, dd);
        // TODO emit event
    }
}
