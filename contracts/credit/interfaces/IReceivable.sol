// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {IERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

interface IReceivable is IERC721 {
    // function ownerOf(uint256 tokenId) external view returns (address);

    // function safeTransferFrom(address _from, address _to, uint256 _tokenId) external;

    // function burn(uint256 tokenId) external;
    //？function onReceivedPayment() external;

    function declarePaymentReceived() external;

    function declareDefault() external;

    function getStatus() external view;
}
