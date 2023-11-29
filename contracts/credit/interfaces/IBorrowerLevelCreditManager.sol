// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditRecord} from "../CreditStructs.sol";

interface IBorrowerLevelCreditManager {
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
    function approveBorrower(
        address borrower,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving
    ) external;

    /**
     * @notice Updates the account and brings its billing status current
     * @dev If the account is defaulted, no need to update the account anymore.
     */
    function refreshCredit(address borrower) external;

    /**
     * @notice Triggers the default process
     * @return principalLoss the amount of principal loss
     * @return yieldLoss the amount of yield loss
     * @return feesLoss the amount of fees loss
     * @dev It is possible for the borrower to payback even after default, especially in
     * receivable factoring cases.
     */
    function triggerDefault(
        address borrower
    ) external returns (uint256 principalLoss, uint256 yieldLoss, uint256 feesLoss);

    /**
     * @notice Closes a credit record.
     * @dev Only borrower or EA Service account can call this function
     * @dev Revert if there is still balance due
     * @dev Revert if the committed amount is non-zero and there are periods remaining
     */
    function closeCredit(address borrower) external;

    /**
     * @notice Pauses the credit. No drawdown is allowed for paused credit.
     * @param borrower the address of the borrower
     * @dev Only EA can call this function
     */
    function pauseCredit(address borrower) external;

    /**
     * @notice Unpauses the credit to return the credit to normal
     * @param borrower the address of the borrower
     * @dev Only EA can call this function
     */
    function unpauseCredit(address borrower) external;

    /**
     * @notice Updates the yield for the credit.
     * @param borrower the address of the borrower
     * @param yieldInBps the new yield
     * @dev Only EA can call this function
     */
    function updateYield(address borrower, uint256 yieldInBps) external;

    /**
     * @notice Updates the limit and commitment amount for this credit
     * @param borrower the borrower address of the credit line
     * @param creditLimit the credit limit
     * @param committedAmount the committed amount. The borrower will be charged interest for
     * this amount even if the daily average borrowing amount in a month is less than this amount.
     * @dev Only EA can call this function
     */
    function updateLimitAndCommitment(
        address borrower,
        uint256 creditLimit,
        uint256 committedAmount
    ) external;

    /**
     * @notice Updates the remaining periods of the credit line
     * @param borrower the borrower address of the credit line
     * @param numOfPeriods the new remaining periods
     * @dev Only EA can call this function
     */
    function extendRemainingPeriod(address borrower, uint256 numOfPeriods) external;

    /**
     * @notice Waive late fee
     */
    function waiveLateFee(address borrower, uint256 waivedAmount) external;
}
