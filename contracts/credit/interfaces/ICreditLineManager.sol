// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface ICreditLineManager {
    /**
     * @notice Approves the credit with the terms provided.
     * @param borrower The address of the borrower.
     * @param creditLimit The credit limit of the credit line.
     * @param remainingPeriods The number of periods before the credit line expires.
     * @param yieldInBps The expected yield expressed in basis points, 1% is 100, 100% is 10000.
     * @param committedAmount The amount that the borrower has committed to use. If the used credit
     * is less than this amount, the borrower will be charged yield using this amount.
     * @param designatedStartDate The date on which the credit should be initiated, if the credit has commitment.
     * @param revolving A flag indicating if the repeated borrowing is allowed.
     * @custom:access Only the EA can call this function.
     */
    function approveBorrower(
        address borrower,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount,
        uint64 designatedStartDate,
        bool revolving
    ) external;

    /**
     * @notice Initiates a credit line with a committed amount on the designated start date.
     * This function is intended to be used for credit lines where there is a minimum borrowing
     * commitment. If the borrower fails to drawdown the committed amount within the set timeframe,
     * this function activates the credit line and applies yield based on the committed amount.
     * @param borrower The address of the borrower.
     * @custom:access Only the pool owner and the Sentinel Service can call this function
     */
    function startCommittedCredit(address borrower) external;

    /**
     * @notice Updates the account and brings its billing status current.
     * @param borrower The address of the borrower.
     * @custom:access Anyone can call this function.
     */
    function refreshCredit(address borrower) external;

    /**
     * @notice Triggers the default process.
     * @param borrower The address of the borrower.
     * @return principalLoss The amount of principal loss.
     * @return yieldLoss The amount of yield loss.
     * @return feesLoss The amount of fees loss.
     * @dev It is possible for the borrower to payback even after default, especially in
     * receivable factoring cases.
     * @custom:access Only the EA can call this function
     */
    function triggerDefault(
        address borrower
    ) external returns (uint256 principalLoss, uint256 yieldLoss, uint256 feesLoss);

    /**
     * @notice Closes a credit record.
     * @param borrower The address of the borrower.
     * @custom:access Only the borrower or EA Service account can call this function.
     */
    function closeCredit(address borrower) external;

    /**
     * @notice Pauses the credit. No drawdown is allowed for paused credit.
     * @param borrower The address of the borrower.
     * @custom:access Only the EA can call this function
     */
    function pauseCredit(address borrower) external;

    /**
     * @notice Unpauses the credit to return the credit to normal.
     * @param borrower The address of the borrower.
     * @custom:access Only the EA can call this function.
     */
    function unpauseCredit(address borrower) external;

    /**
     * @notice Updates the yield for the credit.
     * @param borrower The address of the borrower.
     * @param yieldInBps The new yield expressed in basis points.
     * @custom:access Only the EA can call this function.
     */
    function updateYield(address borrower, uint256 yieldInBps) external;

    /**
     * @notice Updates the limit and commitment amount for this credit
     * @param borrower The address of the borrower.
     * @param creditLimit The new credit limit to set.
     * @param committedAmount The new committed amount. The borrower will be charged interest for
     * this amount even if the daily average borrowing amount in a month is less than this amount.
     * @custom:access Only the EA can call this function.
     */
    function updateLimitAndCommitment(
        address borrower,
        uint256 creditLimit,
        uint256 committedAmount
    ) external;

    /**
     * @notice Updates the remaining periods of the credit line
     * @param borrower The address of the borrower.
     * @param numOfPeriods The number of periods to add onto the credit line.
     * @custom:access Only the EA can call this function.
     */
    function extendRemainingPeriod(address borrower, uint256 numOfPeriods) external;

    /**
     * @notice Waives the late fee up to the given limit.
     * @param borrower The address of the borrower.
     * @param waivedAmount The amount of late fee to waive. The actual amount waived is the smaller of
     * this value and the actual amount of late fee due.
     * @custom:access Only the EA can call this function.
     */
    function waiveLateFee(address borrower, uint256 waivedAmount) external;
}
