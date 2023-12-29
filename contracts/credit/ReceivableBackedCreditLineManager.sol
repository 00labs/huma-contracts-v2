// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BorrowerLevelCreditManager} from "./BorrowerLevelCreditManager.sol";
import {ReceivableBackedCreditLineManagerStorage} from "./ReceivableBackedCreditLineManagerStorage.sol";
import {ReceivableInput, CreditLimit} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";
import {IReceivableBackedCreditLineManager} from "./interfaces/IReceivableBackedCreditLineManager.sol";
import {HUNDRED_PERCENT_IN_BPS} from "../SharedDefs.sol";

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

    /// @inheritdoc IReceivableBackedCreditLineManager
    function approveReceivable(address borrower, ReceivableInput memory receivableInput) external {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != humaConfig.eaServiceAccount() && msg.sender != address(credit))
            revert Errors.notAuthorizedCaller();

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
        uint256 incrementalCredit = (getCreditConfig(creditHash).advanceRateInBps *
            receivableInput.receivableAmount) / HUNDRED_PERCENT_IN_BPS;
        CreditLimit memory cl = getCreditLimit(creditHash);
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

    /// @inheritdoc IReceivableBackedCreditLineManager
    function validateReceivable(address borrower, uint256 receivableId) external view {
        if (receivableBorrowerMap[receivableId] != borrower) revert Errors.receivableIdMismatch();
    }

    /// @inheritdoc IReceivableBackedCreditLineManager
    function decreaseCreditLimit(bytes32 creditHash, uint256 amount) external {
        if (msg.sender != address(credit)) revert Errors.notAuthorizedCaller();
        CreditLimit memory cl = getCreditLimit(creditHash);
        if (amount > cl.availableCredit) revert Errors.creditLineExceeded();
        cl.availableCredit -= uint96(amount);
        _creditLimitMap[creditHash] = cl;
    }

    function getCreditLimit(bytes32 creditHash) public view returns (CreditLimit memory) {
        return _creditLimitMap[creditHash];
    }
}
