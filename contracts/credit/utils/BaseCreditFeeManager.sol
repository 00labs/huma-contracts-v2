// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditFeeManager} from "./interfaces/ICreditFeeManager.sol";
import {CreditConfig, CreditRecord, CreditState} from "../CreditStructs.sol";
import {PoolConfig} from "../../PoolConfig.sol";
import {ICalendar} from "../interfaces/ICalendar.sol";
import "../../SharedDefs.sol";
import {Errors} from "../../Errors.sol";
import {PoolConfigCache} from "../../PoolConfigCache.sol";

import "hardhat/console.sol";

contract BaseCreditFeeManager is PoolConfigCache, ICreditFeeManager {
    ICalendar public calendar;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.calendar();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        calendar = ICalendar(addr);
    }

    /**
     * @notice Compute interest and principal
     */
    function accruedDebt(
        uint256 principal,
        uint256 startTime,
        uint256 lastUpdatedTime,
        CreditRecord memory dealRecord
    ) external view virtual returns (uint256 accruedInterest, uint256 accruedPrincipal) {}

    /**
     * @notice Computes the late fee including both the flat fee and percentage fee
     * @param totalBalance the total balance including amount due and unbilled principal
     * @return fees the amount of late fees to be charged
     * @dev Charges only if 1) there is outstanding due, 2) the due date has passed
     */
    function calcLateFee(
        uint256 totalBalance
    ) public view virtual override returns (uint256 fees) {
        uint256 lateFeeBps;
        (fees, lateFeeBps, ) = poolConfig.getFees();

        if (lateFeeBps > 0) fees += (totalBalance * lateFeeBps) / HUNDRED_PERCENT_IN_BPS;
    }

    /**
     * @notice Computes the front loading fee including both the flat fee and percentage fee
     * @param _amount the borrowing amount
     * @return fees the amount of fees to be charged for this borrowing
     */
    function calcFrontLoadingFee(
        uint256 _amount
    ) public view virtual override returns (uint256 fees) {
        uint256 frontLoadingFeeBps;
        (fees, frontLoadingFeeBps) = poolConfig.getFrontLoadingFees();
        if (frontLoadingFeeBps > 0)
            fees += (_amount * frontLoadingFeeBps) / HUNDRED_PERCENT_IN_BPS;
    }

    function getPayoffAmount(
        CreditRecord memory cr,
        uint256 yieldInBps
    ) external view virtual override returns (uint256 payoffAmount) {
        uint256 principal = cr.unbilledPrincipal + cr.totalDue - cr.yieldDue - cr.feesDue;
        payoffAmount = uint256(cr.totalDue + cr.unbilledPrincipal);
        if (block.timestamp < cr.nextDueDate) {
            // Deduct interest of days from now to due date while makes payment before due date
            uint256 remainingYield = (yieldInBps *
                principal *
                (cr.nextDueDate - block.timestamp)) / (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS);
            assert(payoffAmount >= remainingYield);
            payoffAmount -= remainingYield;
        }
    }

    /**
     * @notice Apply front loading fee, distribute the total amount to borrower, pool, & protocol
     * @param borrowAmount the amount of the borrowing
     * @return amtToBorrower the amount that the borrower can take
     * @return platformFees the platform charges
     * @dev the protocol always takes a percentage of the total fee generated
     */
    function distBorrowingAmount(
        uint256 borrowAmount
    ) external view virtual returns (uint256 amtToBorrower, uint256 platformFees) {
        // Calculate platform fee, which includes protocol fee and pool fee
        platformFees = calcFrontLoadingFee(borrowAmount);

        if (borrowAmount < platformFees) revert Errors.borrowingAmountLessThanPlatformFees();

        amtToBorrower = borrowAmount - platformFees;

        return (amtToBorrower, platformFees);
    }

    /**
     * @notice Sets the standard front loading and late fee policy for the fee manager
     * @param _frontLoadingFeeFlat flat fee portion of the front loading fee
     * @param _frontLoadingFeeBps a fee in the percentage of a new borrowing
     * @param _lateFeeFlat flat fee portion of the late
     * @param _lateFeeBps a fee in the percentage of the outstanding balance
     * @dev Only owner can make this setting
     */
    function setFees(
        uint256 _frontLoadingFeeFlat,
        uint256 _frontLoadingFeeBps,
        uint256 _lateFeeFlat,
        uint256 _lateFeeBps,
        uint256 _membershipFee
    ) external {}

    /**
     * @notice Sets the min percentage of principal to be paid in each billing period
     * @param _minPrincipalRateInBps the min % in unit of bps. For example, 5% will be 500
     * @dev Only owner can make this setting
     * @dev This is a global limit of 5000 bps (50%).
     */
    function setMinPrincipalRateInBps(uint256 _minPrincipalRateInBps) external {}

    /**
     * @notice Gets the current total due, fees and interest due, and payoff amount.
     * Because there is no "cron" kind of mechanism, it is possible that the account is behind
     * for multiple cycles due to a lack of activities. This function will traverse through
     * these cycles to get the most up-to-date due information.
     * @dev This is a view only function, it does not update the account status. It is used to
     * help the borrowers to get their balances without paying gases.
     * @dev the difference between totalDue and feesAndInterestDue is required principal payment
     * @dev payoffAmount is good until the next statement date. It includes the interest for the
     * entire current/new billing period. We will ask for allowance of the total payoff amount,
     * but if the borrower pays off before the next due date, we will subtract the interest saved
     * and only transfer an amount lower than the original payoff estimate.
     * @dev please note the first due date is set after the initial drawdown. All the future due
     * dates are computed by adding multiples of the payment interval to the first due date.
     * @param _cr the credit record associated the account
     */
    function getDueInfo(
        CreditRecord memory _cr,
        CreditConfig memory _cc
    )
        public
        view
        virtual
        override
        returns (
            CreditRecord memory cr,
            uint256 periodsPassed,
            uint96 pnlImpact,
            uint96 principalDifference,
            uint96 lossImpact
        )
    {
        //* Reserved for Richard review, to be deleted, please review this function

        // If the due is nonzero and has passed late payment grace period, the account is considered late
        bool isLate = (_cr.totalDue != 0 &&
            block.timestamp >
            _cr.nextDueDate +
                poolConfig.getPoolSettings().latePaymentGracePeriodInDays *
                SECONDS_IN_A_DAY);

        // Directly returns if it is still within the current period or within late payment grace
        // period when there is still a balance due
        if ((block.timestamp <= _cr.nextDueDate) || (_cr.totalDue != 0 && !isLate)) {
            return (_cr, 0, 0, 0, 0);
        }

        /**
         * Loops through the passed periods to generate bills for each period following these steps:
         * 1. Calcuates late fee if it is past due
         * 2. Computes yield for the next period
         * 3. Adds membership fee
         * 4. Calculates the principal due, and minus it from the unbilled principal amount
         * 5. Computes the under-reported profit if there is late fee thus increased principal
         */

        // cr - new credit record
        // _cr - old credit record

        cr = CreditRecord(
            _cr.unbilledPrincipal,
            _cr.nextDueDate,
            _cr.totalDue,
            _cr.yieldDue,
            _cr.feesDue,
            _cr.missedPeriods,
            _cr.remainingPeriods,
            _cr.state
        );

        // console.log("block.timestamp: %s", block.timestamp);

        uint256 secondsOfThisPeriod;
        while (block.timestamp > cr.nextDueDate) {
            uint256 newNextDueDate = calendar.getNextPeriod(
                _cc.calendarUnit,
                _cc.periodDuration,
                cr.nextDueDate
            );
            secondsOfThisPeriod = cr.nextDueDate > 0
                ? newNextDueDate - cr.nextDueDate
                : newNextDueDate - block.timestamp;
            console.log(
                "newNextDueDate: %s, cr.nextDueDate: %s, secondsPerPeriod: %s",
                newNextDueDate,
                cr.nextDueDate,
                secondsOfThisPeriod
            );

            console.log(
                "cr.unbilledPrincipal: %s, cr.totalDue: %s",
                cr.unbilledPrincipal,
                cr.totalDue
            );

            // step 1. calculates late fees
            if (cr.totalDue > 0) {
                cr.unbilledPrincipal += cr.totalDue;
                principalDifference += cr.yieldDue + cr.feesDue;
                //* Reserved for Richard review, to be deleted
                // Add late fees to profit difference too
                pnlImpact += cr.feesDue;
                cr.feesDue = uint96(calcLateFee(cr.unbilledPrincipal));
                // console.log(
                //     "cr.unbilledPrincipal: %s, principalDifference: %s, cr.feesDue: %s",
                //     cr.unbilledPrincipal,
                //     principalDifference,
                //     cr.feesDue
                // );
            }

            // step 2. computes yield for the next period
            cr.yieldDue = uint96(
                (cr.unbilledPrincipal * _cc.yieldInBps * secondsOfThisPeriod) /
                    (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
            );

            // console.log("cr.yieldDue: %s, _cc.yieldInBps: %s", cr.yieldDue, _cc.yieldInBps);

            // step 3. handles membership fee.
            (, , uint256 membershipFee) = poolConfig.getFees();
            cr.feesDue += uint96(membershipFee);

            // console.log("cr.feesDue: %s, membershipFee: %s", cr.feesDue, membershipFee);

            // step 4. computes principal due and adjust unbilled principal
            uint256 principalToBill = (cr.unbilledPrincipal *
                poolConfig.getMinPrincipalRateInBps()) / HUNDRED_PERCENT_IN_BPS;
            cr.totalDue = uint96(cr.feesDue + cr.yieldDue + principalToBill);
            cr.unbilledPrincipal = uint96(cr.unbilledPrincipal - principalToBill);
            console.log(
                "cr.unbilledPrincipal: %s, cr.totalDue: %s, principalToBill: %s",
                cr.unbilledPrincipal,
                cr.totalDue,
                principalToBill
            );

            // Step 5. captures undercounted profit for this period.
            //* Reserved for Richard review, to be deleted
            // block.timestamp > newNextDueDate, it is necessary to avoid to add the interest of principal difference of future time (from now to next due date)
            if (principalDifference > 0 && block.timestamp > newNextDueDate) {
                uint256 yieldInBps = _cc.yieldInBps;
                pnlImpact += uint96(
                    (principalDifference * yieldInBps * secondsOfThisPeriod) /
                        (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
                );
                // console.log(
                //     "principalDifference: %s, timelapsed: %s, pnlImpact: %s",
                //     principalDifference,
                //     secondsOfThisPeriod,
                //     pnlImpact
                // );
            }

            periodsPassed++;
            cr.nextDueDate = uint64(newNextDueDate);
        }

        if (isLate) {
            //* Reserved for Richard review, to be deleted
            // lossImpact is used for the profit difference when the credit becomes late
            // lossImpact consists of 2 parts: 1) the principla of next due - the principal of due when the credit become late
            // e.g. credit due is 10.1, runs this function on 11.3, the next due becomes 12.1
            // 1st part of lossImpact = the principal of 12.1 - the principal of 11.1
            lossImpact =
                (cr.unbilledPrincipal + cr.totalDue - cr.yieldDue - cr.feesDue) -
                (_cr.unbilledPrincipal + _cr.totalDue - _cr.yieldDue - _cr.feesDue);
            console.log(
                "lossImpact: %s, cr.unbilledPrincipal: %s, _cr.unbilledPrincipal",
                lossImpact,
                cr.unbilledPrincipal,
                _cr.unbilledPrincipal
            );
        }

        // captures undercounted profit from previous due date to current time

        uint256 preDueDate = cr.nextDueDate - secondsOfThisPeriod;
        console.log("preDueDate: %s, block.timestamp: %s", preDueDate, block.timestamp);
        if (block.timestamp > preDueDate) {
            //* Reserved for Richard review, to be deleted
            // Add profit difference of the interest of principal difference from the begining of next due to now
            pnlImpact += uint96(
                (principalDifference * _cc.yieldInBps * (block.timestamp - preDueDate)) /
                    (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
            );

            console.log(
                "principalDifference: %s, timelapsed: %s, pnlImpact: %s",
                principalDifference,
                block.timestamp - preDueDate,
                (principalDifference * _cc.yieldInBps * (block.timestamp - preDueDate)) /
                    (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
            );
            if (isLate) {
                //* Reserved for Richard review, to be deleted
                // lossImpact is used for the profit difference when the credit becomes late
                // lossImpact consists of 2 parts: 2) the interest from the begining of next due to now
                // e.g. credit due is 10.1, runs this function on 11.3, the next due becomes 12.1
                // 2nd part of lossImpact = the interest of the principal of 12.1 from 11.1 to 11.3
                lossImpact += uint96(
                    ((cr.unbilledPrincipal + cr.totalDue - cr.yieldDue - cr.feesDue) *
                        _cc.yieldInBps *
                        (block.timestamp - preDueDate)) /
                        (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
                );

                console.log("lossImpact: %s", lossImpact);
            }
        }

        //* Reserved for Richard review, to be deleted, the following is old code for reference
        // uint256 secondsPerPeriod = calendar.getSecondsPerPeriod(
        //     _cc.calendarUnit,
        //     _cc.periodDuration
        // );

        // for (uint256 i = 0; i < periodsPassed; i++) {
        //     // step 1. calculates late fees
        //     if (_cr.totalDue > 0) {
        //         _cr.unbilledPrincipal += _cr.totalDue;
        //         principalDifference += _cr.totalDue;
        //         _cr.feesDue = uint96(calcLateFee(_cr.unbilledPrincipal + _cr.totalDue));
        //     }

        //     // step 2. computes yield for the next period
        //     _cr.yieldDue = uint96(
        //         (((_cr.unbilledPrincipal * _cc.yieldInBps) / HUNDRED_PERCENT_IN_BPS) *
        //             secondsPerPeriod) / SECONDS_IN_A_YEAR
        //     );

        //     // step 3. handles membership fee.
        //     (, , uint256 membershipFee) = poolConfig.getFees();
        //     _cr.yieldDue += uint96(membershipFee);

        //     // step 4. computes principal due and adjust unbilled principal
        //     uint256 principalToBill = (_cr.unbilledPrincipal *
        //         poolConfig.getMinPrincipalRateInBps()) / HUNDRED_PERCENT_IN_BPS;
        //     _cr.totalDue = uint96(_cr.feesDue + _cr.yieldDue + principalToBill);
        //     _cr.unbilledPrincipal = uint96(_cr.unbilledPrincipal - principalToBill);

        //     // Step 5. captures undercounted profit for this period.
        //     pnlImpact += uint96(
        //         (principalDifference * _cc.yieldInBps * secondsPerPeriod) / SECONDS_IN_A_YEAR
        //     );
        // }

        // If passed final period, all principal is due
        if (periodsPassed >= cr.remainingPeriods) {
            cr.totalDue += cr.unbilledPrincipal;
            cr.unbilledPrincipal = 0;
        }
    }
}
