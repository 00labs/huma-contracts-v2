// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, CreditLoss, CreditState, PaymentStatus, PnLTracker, Payment} from "./CreditStructs.sol";
import {ICreditFeeManager} from "./utils/interfaces/ICreditFeeManager.sol";
import {ICredit} from "./interfaces/ICredit.sol";
import {IFlexCredit} from "./interfaces/IFlexCredit.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {BaseCreditStorage} from "./BaseCreditStorage.sol";
import {Errors} from "../Errors.sol";
import {PoolConfig, PoolSettings} from "../PoolConfig.sol";
import "../SharedDefs.sol";
import {HumaConfig} from "../HumaConfig.sol";
import {CalendarUnit} from "../SharedDefs.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPnLManager} from "./interfaces/IPnLManager.sol";

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
    // todo pass pnlManager as a parameter in the initianizer
    IPnLManager pnlManager;

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
     * @notice approve a borrower with set of terms. These terms will be referenced by EA
     * when credits are created for this borrower.
     * @param borrower the borrower address
     * @param creditLimit the credit limit at the borrower level
     * @param numOfPeriods how many periods are approved for the borrower
     * @param yieldInBps expected yields in basis points
     * @param committedAmount the amount the borrower committed to use.
     * @param revolving indicates if the underlying credit line is revolving or not
     * @param receivableRequired whether receivable is required as collateral before a drawdown
     * @param borrowerLevelCredit indicates whether the borrower is allowed to have one or
     * multiple credit line
     * The yield will be computed using the max of this amount and the acutal credit used.
     * @dev Please note CalendarUnit and durationPerPeriodInCalendarUnit are defined at the
     * pool level, managed by PoolConfig. They cannot be customized for each borrower or credit.
     */
    function approveBorrower(
        address borrower,
        uint96 creditLimit,
        uint16 numOfPeriods, // number of periods
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving,
        bool receivableRequired,
        bool borrowerLevelCredit
    ) external virtual override {
        _protocolAndPoolOn();
        onlyEAServiceAccount();

        if (creditLimit <= 0) revert();
        if (numOfPeriods <= 0) revert();

        PoolSettings memory ps = _poolConfig.getPoolSettings();
        _borrowerConfigMap[borrower] = CreditConfig(
            creditLimit,
            committedAmount,
            ps.calendarUnit,
            ps.payPeriodInCalendarUnit,
            numOfPeriods,
            yieldInBps,
            revolving,
            receivableRequired,
            borrowerLevelCredit,
            true
        );

        emit BorrowerApproved(
            borrower,
            creditLimit,
            numOfPeriods,
            yieldInBps,
            committedAmount,
            revolving,
            receivableRequired,
            borrowerLevelCredit
        );
    }

    /**
     * @notice Approves the credit with the terms provided.
     * @param borrower the borrower address
     * @param creditLimit the credit limit of the credit line
     * @param remainingPeriods the number of periods before the credit line expires
     * @param yieldInBps expected yield expressed in basis points, 1% is 100, 100% is 10000
     * @param committedAmount the credit that the borrower has committed to use. If the used credit
     * is less than this amount, the borrower will charged yield using this amount.
     * @param revolving indicates if the underlying credit line is revolving or not
     * @dev only Evaluation Agent can call
     */
    function approveCredit(
        address borrower,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving
    ) external virtual {
        _protocolAndPoolOn();
        onlyEAServiceAccount();

        if (remainingPeriods == 0) revert Errors.zeroPayPeriods();
        if (creditLimit == 0) revert();

        PoolSettings memory ps = _poolConfig.getPoolSettings();

        _maxCreditLineCheck(borrower, creditLimit);

        bytes32 creditHash = getCreditHash(borrower);

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

        cr.revolving = revolving;
        _setCreditRecord(creditHash, cr);

        // :emit CreditApproved(borrower, creditLimit, intervalInDays, remainingPeriods, aprInBps);
    }

    /**
     * @notice Closes a credit record.
     * @dev Only borrower or EA Service account can call this function
     * @dev Revert if there is still balance due
     * @dev Revert if the committed amount is non-zero and there are periods remaining
     */
    function closeCredit(bytes32 creditHash) public virtual {
        CreditRecord memory cr = _getCreditRecord(creditHash);
        onlyBorrowerOrEAServiceAccount(cr.borrower);

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
     * @notice Distributes income to token holders.
     * todo get rid of this function once we know where we have the distributeIncome() function that
     * splits income between poolOwner, EA, firstLossCover provider and the pool. The caller of this
     * function is responsible for updating PnL.
     */
    function distributeIncome(uint256 value) internal virtual returns (uint256 poolIncome) {
        // uint256 poolIncome = _poolConfig.distributeIncome(value);
    }

    /**
     * @notice allows the borrower to borrow against an approved credit line.
     * @param creditHash hash of the credit record
     * @param borrowAmount the amount to borrow
     * @dev Only the owner of the credit line can drawdown.
     */
    function drawdown(bytes32 creditHash, uint256 borrowAmount) public virtual override {
        address borrower = msg.sender;
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (borrower != cr.borrower) revert Errors.notBorrower();

        if (borrowAmount == 0) revert Errors.zeroAmountProvided();

        _checkDrawdownEligibility(cr, borrowAmount);

        uint256 netAmountToBorrower = _drawdown(creditHash, cr, borrowAmount);
        emit DrawdownMade(borrower, borrowAmount, netAmountToBorrower);
    }

    /**
     * @notice Extend the expiration (maturity) date of a credit line
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
     * @notice Makes one payment for the credit line. This can be initiated by the borrower
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
    }

    function pauseCredit(bytes32 creditHash) external {
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
    function refreshCredit(bytes32 creditHash) external virtual returns (CreditRecord memory cr) {
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
    function requestEarlyPrincipalWithdrawal(uint96 amount) external virtual override {
        // todo Only allows the Pool(?) contract to call
        // todo Check against poolConfig to make sure FlexCredit is allowed by this pool
        if (activeCreditsHash.length != 1) revert Errors.todo();
        _getCreditRecord(activeCreditsHash[0]).totalDue += amount;
    }

    /**
     * @notice Requests additional principal payment in the upcoming period.
     * @param creditHash - the hash of the credit record
     * @param amount - the extra principal that becomes due
     */
    function requestExtraPrincipalPayment(bytes32 creditHash, uint256 amount) external {
        // todo decide whether this function is called by service account or a contract
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
    function triggerDefault(bytes32 creditHash) external virtual returns (uint256 losses) {
        _protocolAndPoolOn();

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

    function unpauseCredit(bytes32 creditHash) external {
        CreditRecord memory cr = _getCreditRecord(creditHash);
        if (cr.state == CreditState.Paused) {
            cr.state = CreditState.GoodStanding;
            _setCreditRecord(creditHash, cr);
        }
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
        CreditRecord memory cr = _getCreditRecord(creditHash);

        _maxCreditLineCheck(cr.borrower, newAvailableCredit);

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
        _maxCreditLineCheck(borrower, newCreditLimit);
        _borrowerConfigMap[borrower].creditLimit = newCreditLimit;

        // emit CreditLineChanged(borrower, oldCreditLimit, newCreditLimit);
    }

    function updateYield(address borrower, uint yieldInBps) external {}

    function creditRecordMap(bytes32 creditHash) external view returns (CreditRecord memory) {
        return _creditRecordMap[creditHash];
    }

    function creditConfigMap(bytes32 creditHash) external view returns (CreditConfig memory) {
        return _creditConfigMap[creditHash];
    }

    function currentPnL()
        external
        view
        returns (uint256 profit, uint256 loss, uint256 lossRecovery)
    {
        return pnlManager.getPnLSum();
    }

    function getCreditHash(address borrower) public view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), borrower));
    }

    function getCreditHash(
        address borrower,
        address receivableAsset,
        uint256 receivableId
    ) public view virtual returns (bytes32 creditHash) {}

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
     * @notice drawdown helper function.
     * @param creditHash the credit hash
     * @param borrowAmount the amount to borrow
     * @dev Eligibility check is done outside this function.
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

            // Adjust the new due amount due to the yield generated because of the drawdown
            // amount for the rest of this period
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
     * @notice Borrower makes one payment. If the payment amount equals to or is higher
     * than the payoff amount, it automatically triggers the payoff process. The protocol
     * never accepts payment amount that is higher than the payoff amount.
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
                        _poolConfig.getPoolSettings().latePaymentGracePeriodInDays *
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
                emit CreditLineClosed(cr.borrower, msg.sender, CreditLineClosureReason.Paidoff);
            } else cr.state = CreditState.GoodStanding;
        }

        if (p.amountToCollect > 0) {
            _underlyingToken.safeTransferFrom(cr.borrower, address(this), p.amountToCollect);
            emit PaymentMade(
                cr.borrower,
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

    /// Checks if the given amount is higher than what is allowed by the pool
    function _maxCreditLineCheck(address borrower, uint256 amount) internal view {
        if (amount > _poolConfig.getPoolSettings().maxCreditLine) {
            revert Errors.greaterThanMaxCreditLine();
        }

        if (amount > _borrowerConfigMap[borrower].creditLimit) {
            revert Errors.greaterThanMaxCreditLine();
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
        // If the due is nonzero and has passed late payment grace period, the account is considered late
        bool lateFlag = (cr.totalDue != 0 &&
            block.timestamp >
            cr.nextDueDate +
                _poolConfig.getPoolSettings().latePaymentGracePeriodInDays *
                SECONDS_IN_A_DAY);

        (
            periodsPassed,
            cr.feesDue,
            cr.yieldDue,
            cr.totalDue,
            cr.unbilledPrincipal,
            missedProfit,
            principalDiff
        ) = _feeManager.getDueInfo(cr, cc);

        if (periodsPassed > 0) {
            pnlManager.processDueUpdate(principalDiff, missedProfit, lateFlag, creditHash, cc, cr);

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

    /// "Modifier" function that limits access only when both protocol and pool are on.
    /// Did not use modifier for contract size consideration.
    function _protocolAndPoolOn() internal view {
        if (_humaConfig.paused()) revert Errors.protocolIsPaused();
        // if (_status != PoolStatus.On) revert Errors.poolIsNotOn();
    }

    // todo provide an external view function for credit payment due list ?
}
