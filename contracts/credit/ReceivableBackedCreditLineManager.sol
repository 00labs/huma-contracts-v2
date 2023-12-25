// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BorrowerLevelCreditManager} from "./BorrowerLevelCreditManager.sol";
import {ReceivableBackedCreditLineManagerStorage} from "./ReceivableBackedCreditLineManagerStorage.sol";
import {ReceivableInput, CreditLimit} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";
import {IReceivableBackedCreditLineManager} from "./interfaces/IReceivableBackedCreditLineManager.sol";

contract ReceivableBackedCreditLineManager is
    IReceivableBackedCreditLineManager,
    BorrowerLevelCreditManager,
    ReceivableBackedCreditLineManagerStorage
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
        if (msg.sender != humaConfig.eaServiceAccount() && msg.sender != address(credit))
            revert Errors.todo();

        if (receivableInput.receivableAmount == 0) revert Errors.zeroAmountProvided();
        if (receivableInput.receivableId == 0) revert Errors.zeroReceivableIdProvided();

        bytes32 creditHash = getCreditHash(borrower);
        onlyCreditBorrower(creditHash, borrower);

        _approveReceivable(borrower, creditHash, receivableInput);
    }

    function _approveReceivable(
        address borrower,
        bytes32 creditHash,
        ReceivableInput memory receivableInput
    ) internal {
        uint256 incrementalCredit = getCreditConfig(creditHash).advanceRateInBps *
            receivableInput.receivableAmount;
        CreditLimit memory cl = _creditLimitMap[creditHash];
        cl.availableCredit += uint96(incrementalCredit);
        _creditLimitMap[creditHash] = cl;

        receivableBorrowerMap[receivableInput.receivableId] = borrower;

        emit ReceivableApproved(
            borrower,
            receivableInput.receivableId,
            receivableInput.receivableAmount,
            incrementalCredit,
            cl.availableCredit
        );
    }

    function validateReceivable(address borrower, uint256 receivableId) external view {
        // TODO(jiatu): this error is misleading. Rename it.
        if (receivableBorrowerMap[receivableId] != borrower) revert Errors.receivableIdMismatch();
    }

    function decreaseCreditLimit(bytes32 creditHash, uint256 amount) external {
        if (msg.sender != address(credit)) revert Errors.todo();
        CreditLimit memory cl = _creditLimitMap[creditHash];
        if (amount > cl.availableCredit) revert Errors.todo();
        cl.availableCredit -= uint96(amount);
        _creditLimitMap[creditHash] = cl;
    }

    function getCreditLimit(bytes32 creditHash) public view returns (CreditLimit memory) {
        return _creditLimitMap[creditHash];
    }
}
