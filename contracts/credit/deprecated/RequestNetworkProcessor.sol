// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

//* Reserved for Richard review, to be deleted, delete this contract

// import {IReceivableFactoring, ReceivableInfo, CreditConfig} from "./interfaces/IReceivableFactoring.sol";

// /**
//  * @notice RequestNetworkProcessor handles the special makePayment about RN integration.
//  * RequestNetworkProcessor creates a new intermedia NFT for ReceivableFactoring actions.
//  * RequestNetworkProcessor holds real RN NFTs.
//  */

// contract RequestNetworkProcessor {
//     IReceivableFactoring public rf;

//     function approve(
//         address borrower,
//         uint256 creditLimit,
//         CreditConfig calldata creditConfig,
//         uint256 rnReceivableAsset,
//         uint256 rnReceivableAmount,
//         uint256 rnReceivableId
//     ) external returns (bytes32 hash) {
//         // store RN receivable info

//         // generate an intermedia NFT

//         ReceivableInfo memory ri;
//         ri.receivableAmount = uint96(rnReceivableAmount);
//         // ri.receivableAsset = intermedia NFT address (It is likely to be this contract address)
//         // ri.receivableId = intermedia NFT id generated above
//         hash = rf.approve(borrower, creditLimit, creditConfig, ri);
//     }

//     function drawdown(bytes32 hash, uint256 borrowAmount) external {
//         // RN special logic
//         // verify and transfer RN receivable to this contract

//         rf.drawdown(hash, borrowAmount);
//     }

//     function makePayment(bytes32 hash, uint256 amount) external {
//         // only bot can call this

//         (, bool paidoff) = rf.makePayment(hash, amount);

//         if (paidoff) {
//             // RN special logic
//             // burn RN receivable?
//         }
//     }
// }
