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
}
