// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {ReceivableInfo, ReceivableState} from "../CreditStructs.sol";

interface IReceivable {
    function createReceivable(
        uint16 currencyCode,
        uint96 receivableAmount,
        uint64 maturityDate,
        string memory uri
    ) external;

    function declarePayment(uint256 tokenId, uint96 paymentAmount) external;

    function getStatus(uint256 tokenId) external returns (ReceivableState state);
}
