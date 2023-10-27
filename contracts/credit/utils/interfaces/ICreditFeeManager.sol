// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord} from "../../CreditStructs.sol";

/**
 * @notice ICreditFeeManager defines functions to compute credit-related fees
 */

interface ICreditFeeManager {
    // /**
    //  * @notice Calculates accrued interest and accrued principal from last updated timestamp to current timestamp.
    //  * @param principal the principal amount
    //  * @param startTime the loan start timestamp
    //  * @param lastUpdatedTime the last updated timestamp
    //  * @param creditRecord the schedule and payment parameters for this loan
    //  * @return accruedInterest the accrued interest from last updated timestamp to current timestamp,
    //  * accruedPrincipal the accrued principal from last updated timestamp to current timestamp,
    //  */
    // function accruedDebt(
    //     uint256 principal,
    //     uint256 startTime,
    //     uint256 lastUpdatedTime,
    //     CreditRecord memory creditRecord
    // ) external view returns (uint256 accruedInterest, uint256 accruedPrincipal);

    /**
     * @notice Apply front loading fee, distribute the total amount to borrower, pool, & protocol
     * @param borrowAmount the amount of the borrowing
     * @return amtToBorrower the amount that the borrower can take
     * @return platformFees the platform charges
     * @dev the protocol always takes a percentage of the total fee generated
     */
    function distBorrowingAmount(
        uint256 borrowAmount
    ) external view returns (uint256 amtToBorrower, uint256 platformFees);

    /**
     * @notice Computes the front loading fee, which is also known as origination fee.
     * @param _amount the borrowing amount
     * @return fees the amount of fees to be charged for this borrowing
     */
    function calcFrontLoadingFee(uint256 _amount) external view returns (uint256 fees);

    /**
     * @notice Computes the yield for a period, including regular yields and late
     * charges if apply
     * @param principal the outstanding principal
     * @param baseYieldInBps the base yield rate in bps
     * @param periodDuration the number of months per period
     * @return yieldDue the yield amount for a period
     */
    function calcYieldDuePerPeriod(
        uint256 principal,
        uint256 baseYieldInBps,
        uint256 periodDuration,
        bool isLate
    ) external view returns (uint256 yieldDue);

    /**
     * @notice Gets the current total due, fees and interest due, and payoff amount.
     * Because there is no "cron" kind of mechanism, it is possible that the account is behind
     * for multiple cycles due to lack of activities. This function will traverse through
     * these cycles to get the most up-to-date due information.
     * @dev This is a view only function, it does not update the account status. It is used to
     * help the borrowers to get their balances without paying gases.
     * @dev the difference between nextDue and yieldDue is the required principal payment
     * @dev please note the first due date is set after the initial drawdown. All the future due
     * dates are computed by adding multiples of the payment interval to the first due date.
     * @param _cr the credit record associated with the account
     * @param _cc the credit config associated with with account
     * @return cr the updated credit record with the most up-to-date due information
     * @return periodsPassed the number of billing periods has passed since the last statement
     * @return isLate whether the credit is delayed, true means the credit is delayed,
     * otherwise it means the credit is in good standing.
     */
    function getDueInfo(
        CreditRecord memory _cr,
        CreditConfig memory _cc
    ) external view returns (CreditRecord memory cr, uint256 periodsPassed, bool isLate);

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
    ) external;

    /**
     * @notice Sets the min percentage of principal to be paid in each billing period
     * @param _minPrincipalRateInBps the min % in unit of bps. For example, 5% will be 500
     * @dev Only owner can make this setting
     * @dev This is a global limit of 5000 bps (50%).
     */
    function setMinPrincipalRateInBps(uint256 _minPrincipalRateInBps) external;

    function getPayoffAmount(
        CreditRecord memory cr,
        uint256 yieldInBps
    ) external view returns (uint256 payoffAmount);
}
