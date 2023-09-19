// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord} from "../../CreditStructs.sol";

/**
 * @notice ICreditFeeManager defines functions to compute credit-related fees
 */

interface ICreditFeeManager {
    /**
     * @notice Calculates accrued interest and accrued principal from last updated timestamp to current timestamp.
     * @param principal the principal amount
     * @param startTime the loan start timestamp
     * @param lastUpdatedTime the last updated timestamp
     * @param creditRecord the schedule and payment parameters for this loan
     * @return accruedInterest the accrued interest from last updated timestamp to current timestamp,
     * accruedPrincipal the accrued principal from last updated timestamp to current timestamp,
     */
    function accruedDebt(
        uint256 principal,
        uint256 startTime,
        uint256 lastUpdatedTime,
        CreditRecord memory creditRecord
    ) external view returns (uint256 accruedInterest, uint256 accruedPrincipal);

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
     * @notice Computes the late fee including both the flat fee and percentage fee
     * @param balance the total balance including amount due and unbilled principal
     * @return fees the amount of late fees to be charged
     * @dev Charges only if 1) there is outstanding due, 2) the due date has passed
     */
    function calcLateFee(uint256 balance) external view returns (uint256 fees);

    /**
     * @notice Gets the current total due, fees and interest due, and payoff amount.
     * Because there is no "cron" kind of mechanism, it is possible that the account is behind
     * for multiple cycles due to a lack of activities. This function will traverse through
     * these cycles to get the most up-to-date due information.
     * @param _cr the credit record associated the account
     * @return cr
     * @return periodsPassed the number of billing periods has passed since the last statement.
     * @return pnlImpact the pnl impact of the account since the last statement
     * @return principalDifference the principal difference of the account since the last statement
     * @return lossImpact the loss impact of the account since the last statement. If it is great than 0,
     * it means the credit is delayed, otherwise it means the credit is good standing.
     * If it is within the same period, it will be 0.
     */
    function getDueInfo(
        CreditRecord memory _cr,
        CreditConfig memory _cc
    )
        external
        view
        returns (
            CreditRecord memory cr,
            uint256 periodsPassed,
            uint96 pnlImpact,
            uint96 principalDifference,
            uint96 lossImpact
        );

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
