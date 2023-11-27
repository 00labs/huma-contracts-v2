// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BorrowerLevelCreditConfig} from "./BorrowerLevelCreditConfig.sol";
import {ReceivableInput} from "./CreditStructs.sol";
import {ReceivableBackedCreditLineStorage} from "./ReceivableBackedCreditLineStorage.sol";
import {CreditConfig, CreditRecord, CreditLimit} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

contract ReceivableBackedCreditLine is
    BorrowerLevelCreditConfig,
    ReceivableBackedCreditLineStorage
{
    event ReceivableApproved(
        address borrower,
        uint256 receivableId,
        uint256 receivableAmount,
        uint256 incrementalCredit,
        uint256 availableCredit
    );

    /**
     * @notice Approves a receivable, adjusts availableCredit by applying advantce ratio
     * @dev Only when the protocol and pool are live.
     * @dev only EA service account can call this function
     */
    function approveReceivable(address borrower, ReceivableInput memory receivableInput) external {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();
        _approveReceivable(borrower, receivableInput);
    }

    function _approveReceivable(
        address borrower,
        ReceivableInput memory receivableInput
    ) internal {
        bytes32 creditHash = getCreditHash(borrower);

        uint256 incrementalCredit = getCreditConfig(creditHash).advanceRateInBps *
            receivableInput.receivableAmount;
        CreditLimit memory cl = getCreditLimit(creditHash);
        cl.availableCredit += uint96(incrementalCredit);
        _setCreditLimit(creditHash, cl);

        receivableBorrowerMap[receivableInput.receivableId] = borrower;

        emit ReceivableApproved(
            borrower,
            receivableInput.receivableId,
            receivableInput.receivableAmount,
            incrementalCredit,
            cl.availableCredit
        );
    }

    /**
     * @notice Allows the borrower to drawdown using a receivable.
     */
    function drawdownWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) public virtual {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) revert Errors.notBorrower();
        // todo Verify the owner of the receivable is the borrower

        if (receivableId == 0) revert Errors.todo();
        // todo check if CreditConfig indicates it is auto approve or not, If yes, call approveReceivable()
        // otherwise, check if the receivable has been approved.

        if (amount == 0) revert Errors.zeroAmountProvided();
        // todo check to make sure the amount is below availableCredit

        bytes32 creditHash = getCreditHash(borrower);
        if (borrower != creditBorrowerMap[creditHash]) revert Errors.notBorrower();

        // todo transfer the receivable to the PoolSafe?

        _drawdown(borrower, creditHash, amount);

        // emit event
    }

    /**
     * @notice Allows the borrower to payback and label it with a receivable
     */
    function makePaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) _onlyPDSServiceAccount();
        if (receivableBorrowerMap[receivableId] != borrower) revert Errors.todo();
        // todo update the receivable to indicate it is paid.

        bytes32 creditHash = getCreditHash(borrower);
        (amountPaid, paidoff, ) = _makePayment(borrower, creditHash, amount);

        // emit event
    }

    /**
     * @notice Allows the borrower to make principal payment and label it with a receivable
     */
    function makePrincipalPaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) _onlyPDSServiceAccount();
        if (receivableBorrowerMap[receivableId] != borrower) revert Errors.todo();
        // todo update the receivable to indicate it is paid.

        bytes32 creditHash = getCreditHash(borrower);
        (amountPaid, paidoff) = _makePrincipalPayment(borrower, creditHash, amount);

        // emit event
    }

    /**
     * @notice Allows the borrower to payback and label it with a receivable
     */
    function makePrincipalPaymentAndDrawdownWithReceivable(
        address borrower,
        uint256 paymentReceivableId,
        uint256 drawdownReceivableId,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        (amountPaid, paidoff) = makePrincipalPaymentWithReceivable(
            borrower,
            paymentReceivableId,
            amount
        );
        drawdownWithReceivable(borrower, drawdownReceivableId, amount);
    }
}
