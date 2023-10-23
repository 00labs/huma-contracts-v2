// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditRecord} from "../CreditStructs.sol";

interface ICreditLine {
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
     * @notice allows the borrower to borrow against an approved credit line.
     * @param borrower hash of the credit record
     * @param borrowAmount the amount to borrow
     * @dev Only the owner of the credit line can drawdown.
     */
    function drawdown(address borrower, uint256 borrowAmount) external;

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
        address borrower,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

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
    function refreshCredit(address borrower) external;

    /**
     * @notice Triggers the default process
     * @return losses the amount of remaining losses to the pool
     * @dev It is possible for the borrower to payback even after default, especially in
     * receivable factoring cases.
     */
    function triggerDefault(address borrower) external returns (uint256 losses);

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
     * @notice Unpause the credit to return the credit to normal
     * @param borrower the address of the borrower
     * @dev Only EA can call this function
     */
    function unpauseCredit(address borrower) external;

    /**
     * @notice Unpause the credit to return the credit to normal
     * @param borrower the address of the borrower
     * @dev Only EA can call this function
     */
    function updateYield(address borrower, uint256 yieldInBps) external;

    /**
     * @notice Unpauses the credit to return the credit to normal
     * @param borrower the borrower address of the credit line
     * @dev Only EA can call this function
     */
    function updateLimitAndCommitment(
        address borrower,
        uint256 creditLimit,
        uint256 committedAmount
    ) external;

    /**
     * @notice Extends the remaining periods of the credit line
     * @param borrower the borrower address of the credit line
     * @param numOfPeriods the new remaining periods
     * @dev Only EA can call this function
     */
    function updateRemainingPeriods(address borrower, uint256 numOfPeriods) external;
}
