// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface IReceivable {
    function ownerOf(uint256 tokenId) external view returns (address);

    function safeTransferFrom(address _from, address _to, uint256 _tokenId) external;

    function burn(uint256 tokenId) external;
}
