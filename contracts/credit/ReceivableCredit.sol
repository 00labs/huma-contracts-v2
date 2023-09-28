// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IReceivableCredit} from "./interfaces/IReceivableCredit.sol";
import {BaseCredit} from "./BaseCredit.sol";
import {ReceivableInput} from "./CreditStructs.sol";
import {CreditRecord} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

//* Reserved for Richard review, to be deleted
// This contract is for Arf case.

contract ReceivableCredit is BaseCredit, IReceivableCredit {
    function approveReceivable(
        address borrower,
        ReceivableInput memory receivableInput,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount
    ) external {
        poolConfig.onlyProtocolAndPoolOn();
        onlyEAServiceAccount();

        bytes32 creditHash = getCreditHash(receivableInput.receivableId);
        _approveCredit(
            borrower,
            creditHash,
            creditLimit,
            remainingPeriods,
            yieldInBps,
            committedAmount,
            false
        );

        //* Reserved for Richard review, to be deleted
        // is there any action for receivable? validate the receivable amount if is greater than creditLimit?
    }

    function drawdownWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external virtual {
        //* Reserved for Richard review, to be deleted
        // TODO poolConfig.onlyProtocolAndPoolOn(); ?
        // Verify the owner of the receivable is the borrower?

        if (msg.sender != borrower) revert Errors.notBorrower();
        if (receivableId == 0) revert Errors.todo();
        if (amount == 0) revert Errors.zeroAmountProvided();
        bytes32 creditHash = getCreditHash(receivableId);
        if (borrower != _creditBorrowerMap[creditHash]) revert Errors.notBorrower();

        _drawdown(borrower, creditHash, amount);
    }

    function makePaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) onlyPDSServiceAccount();
        bytes32 creditHash = getCreditHash(receivableId);
        if (borrower != _creditBorrowerMap[creditHash]) revert Errors.notBorrower();
        (amountPaid, paidoff, ) = _makePayment(borrower, creditHash, amount);
    }

    function refreshCredit(uint256 receivableId) external {
        bytes32 creditHash = getCreditHash(receivableId);
        _refreshCredit(creditHash);
    }

    function triggerDefault(uint256 receivableId) external returns (uint256 losses) {
        bytes32 creditHash = getCreditHash(receivableId);
        _triggerDefault(creditHash);
    }

    function closeCredit(uint256 receivableId) external {
        bytes32 creditHash = getCreditHash(receivableId);
        _closeCredit(creditHash);
    }

    function pauseCredit(uint256 receivableId) external {
        bytes32 creditHash = getCreditHash(receivableId);
        _pauseCredit(creditHash);
    }

    function unpauseCredit(uint256 receivableId) external {
        bytes32 creditHash = getCreditHash(receivableId);
        _unpauseCredit(creditHash);
    }

    function updateYield(uint256 receivableId, uint256 yieldInBps) external {
        bytes32 creditHash = getCreditHash(receivableId);
        _updateYield(creditHash, yieldInBps);
    }

    //* Reserved for Richard review, to be deleted
    // I think receivableAsset + receivableId is a better key without borrower,
    // because it looks strange to ask user to input borrower address for management functions such as refreshCredit/closeCredit
    function getCreditHash(
        uint256 receivableId
    ) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), poolConfig.receivableAsset(), receivableId));
    }
}
