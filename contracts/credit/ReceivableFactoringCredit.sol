// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC721, IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReceivableCredit} from "./ReceivableCredit.sol";
import {Errors} from "../Errors.sol";

contract ReceivableFactoringCredit is ReceivableCredit, IERC721Receiver {
    function drawdownWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external override {
        //* Reserved for Richard review, to be deleted
        // TODO poolConfig.onlyProtocolAndPoolOn(); ?

        if (msg.sender != borrower) revert Errors.notBorrower();
        if (receivableId == 0) revert Errors.todo();
        if (amount == 0) revert Errors.zeroAmountProvided();
        bytes32 creditHash = getCreditHash(receivableId);
        if (borrower != _creditBorrowerMap[creditHash]) revert Errors.notBorrower();

        address receivableAsset = poolConfig.receivableAsset();
        IERC721(receivableAsset).safeTransferFrom(borrower, address(this), receivableId);

        _drawdown(borrower, creditHash, amount);
    }

    function makePaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) public override returns (uint256 amountPaid, bool paidoff) {
        (amountPaid, paidoff) = super.makePaymentWithReceivable(borrower, receivableId, amount);

        //* Reserved for Richard review, to be deleted
        // Mark the receivable as paid off? Transfer the receivable to the borrower back?
    }

    function onERC721Received(
        address /*operator*/,
        address /*from*/,
        uint256 /*tokenId*/,
        bytes calldata /*data*/
    ) external virtual returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
