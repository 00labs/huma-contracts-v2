// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IReceivableFactoring, ReceivableInfo, CreditConfig} from "./interfaces/IReceivableFactoring.sol";

/**
 * @notice SuperfluidProcessor handles all speicial actions about Superfulid integration.
 * SuperfluidProcessor creates a new intermedia NFT for ReceivableFactoring actions. SuperfluidProcessor holds real
 * Superfluid NFTs.
 */

contract SuperfluidProcessor {
    IReceivableFactoring public rf;

    function approve(
        address borrower,
        uint256 creditLimit,
        CreditConfig calldata creditConfig,
        uint256 superfluidReceivableAsset,
        uint256 superfluidReceivableAmount,
        bytes32 superfluidReceivableDataHash
    ) external returns (bytes32 hash) {
        // store superfluid receivable data hash

        // generate an intermedia NFT

        ReceivableInfo memory ri;
        ri.receivableAmount = uint96(superfluidReceivableAmount);
        // ri.receivableAsset = intermedia NFT address (It is likely to be this contract address)
        // ri.receivableId = intermedia NFT id generated above
        hash = rf.approve(borrower, creditLimit, creditConfig, ri);
    }

    function mintAndDrawdown(
        bytes32 hash,
        address borrower,
        uint256 borrowAmount,
        address superfluidReceivableAsset,
        bytes calldata superfluidReceivableMintData
    ) external {
        // verify superfluidReceivableAsset and dataForMintTo(with superfluidReceivableDataHash in approve call)

        // Superfluid special logic
        // mint Superfluid receivable to this contract

        rf.drawdown(hash, borrowAmount);
    }

    function makePayment(bytes32 hash) external {
        // Superfluid special logic
        uint256 amount;
        // collect underlying tokens from Superfluid receivable

        (, bool paidoff) = rf.makePayment(hash, amount);

        if (paidoff) {
            // Superfluid special logic
            // burn Superfluid receivable
        }
    }
}
