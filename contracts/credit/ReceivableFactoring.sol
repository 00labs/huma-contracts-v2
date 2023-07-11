// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseCredit, CreditLimit} from "./BaseCredit.sol";
import {IReceivable} from "./interfaces/IReceivable.sol";
import {IReceivableFactoring, ReceivableInfo, CreditConfig, ICredit} from "./interfaces/IReceivableFactoring.sol";

contract ReceivableFactoring is BaseCredit, IReceivableFactoring {
    mapping(bytes32 => ReceivableInfo) public receivables;

    function approve(
        address borrower,
        uint256 creditLimit,
        CreditConfig calldata creditConfig,
        ReceivableInfo memory receivableInfo
    ) external override returns (bytes32 hash) {
        // verify receivable
        //   a. verify if receivable asset address is valid
        //   b. verify if borrower is the owner of the receivable id

        hash = keccak256(abi.encode(borrower, receivableInfo));
        //_approve(hash, borrower, creditLimit, creditConfig);

        // create & store receivable info
    }

    function drawdown(
        bytes32 hash,
        uint256 borrowAmount
    ) public virtual override(BaseCredit, ICredit) {
        // check parameters
        ReceivableInfo memory ri = receivables[hash];
        if (ri.receivableId == 0) revert();
        if (IReceivable(ri.receivableAsset).ownerOf(ri.receivableId) != address(this)) {
            CreditLimit memory cl; // = creditLimits[hash];
            IReceivable(ri.receivableAsset).safeTransferFrom(
                cl.borrower,
                address(this),
                ri.receivableId
            );
        }

        drawdown(hash, borrowAmount);
    }

    function makePayment(
        bytes32 hash,
        uint256 amount
    ) public virtual override(BaseCredit, ICredit) returns (uint256 amountPaid, bool paidoff) {
        super.makePayment(hash, amount);

        // burn receivable?
    }
}
