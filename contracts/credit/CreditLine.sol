// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditLine} from "./interfaces/ICreditLine.sol";
import {BaseCredit} from "./BaseCredit.sol";
import {CreditRecord} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

import "hardhat/console.sol";

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
contract CreditLine is BaseCredit, ICreditLine {
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
    ) external virtual {
        _protocolAndPoolOn();
        onlyEAServiceAccount();

        bytes32 creditHash = getCreditHash(borrower);
        _approveCredit(
            borrower,
            creditHash,
            creditLimit,
            remainingPeriods,
            yieldInBps,
            committedAmount,
            revolving
        );
    }

    /**
     * @notice allows the borrower to borrow against an approved credit line.
     * @param borrower hash of the credit record
     * @param borrowAmount the amount to borrow
     * @dev Only the owner of the credit line can drawdown.
     */
    function drawdown(address borrower, uint256 borrowAmount) external {
        if (borrower == address(0)) revert Errors.zeroAddressProvided();
        if (borrowAmount == 0) revert Errors.zeroAmountProvided();
        bytes32 creditHash = getCreditHash(borrower);
        _drawdown(borrower, creditHash, borrowAmount);
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
        address borrower,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff) {
        if (msg.sender != borrower) onlyPDSServiceAccount();
        bytes32 creditHash = getCreditHash(borrower);
        (amountPaid, paidoff, ) = _makePayment(borrower, creditHash, amount);
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
    function refreshCredit(address borrower) external returns (CreditRecord memory cr) {
        bytes32 creditHash = getCreditHash(borrower);
        _refreshCredit(creditHash);
    }

    /**
     * @notice Triggers the default process
     * @return losses the amount of remaining losses to the pool
     * @dev It is possible for the borrower to payback even after default, especially in
     * receivable factoring cases.
     */
    function triggerDefault(address borrower) external returns (uint256 losses) {
        bytes32 creditHash = getCreditHash(borrower);
        _triggerDefault(creditHash);
    }

    /**
     * @notice Closes a credit record.
     * @dev Only borrower or EA Service account can call this function
     * @dev Revert if there is still balance due
     * @dev Revert if the committed amount is non-zero and there are periods remaining
     */
    function closeCredit(address borrower) external {
        bytes32 creditHash = getCreditHash(borrower);
        _closeCredit(borrower, creditHash);
    }

    function pauseCredit(address borrower) external {
        bytes32 creditHash = getCreditHash(borrower);
        _pauseCredit(creditHash);
    }

    function unpauseCredit(address borrower) external {
        bytes32 creditHash = getCreditHash(borrower);
        _unpauseCredit(creditHash);
    }

    function updateYield(
        address borrower,
        uint256 yieldInBps
    ) public override(BaseCredit, ICreditLine) {
        BaseCredit.updateYield(borrower, yieldInBps);
    }

    function getCreditHash(address borrower) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), borrower));
    }
}
