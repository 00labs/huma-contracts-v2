// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ERC721, IERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Counters} from "@openzeppelin/contracts/utils/Counters.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Errors} from "./Errors.sol";

contract EvaluationAgentNFT is ERC721URIStorage, Ownable {
    using Counters for Counters.Counter;
    Counters.Counter private _tokenIds;

    /**
     * @notice An EA NFT has been created.
     * @param tokenId The ID of the EA NFT.
     * @param recipient The recipient of the EA NFT.
     */
    event NFTGenerated(uint256 tokenId, address recipient);

    /**
     * @notice The URI of an EA NFT has been set.
     * @param tokenId The ID of the EA NFT.
     * @param tokenURI The new URI of the EA NFT.
     */
    event SetURI(uint256 tokenId, string tokenURI);

    constructor() ERC721("EvaluationAgentNFT", "EANFT") {}

    /**
     * @notice Minting an NFT only gets a placeholder for an EA.
     * The NFT has attributes such as "status" that can only be updated by
     * Huma to indicate whether the corresponding EA is approved or not.
     * Merely owning an EA NFT does NOT mean the owner has any authority.
     */
    function mintNFT(address recipient) external returns (uint256) {
        _tokenIds.increment();

        uint256 newItemId = _tokenIds.current();
        _mint(recipient, newItemId);

        emit NFTGenerated(newItemId, recipient);
        return newItemId;
    }

    function burn(uint256 tokenId) external returns (uint256) {
        if (msg.sender != ownerOf(tokenId)) revert Errors.NFTOwnerRequired();
        _burn(tokenId);
        return tokenId;
    }

    function setTokenURI(uint256 tokenId, string memory uri) external onlyOwner {
        emit SetURI(tokenId, uri);
        _setTokenURI(tokenId, uri);
    }

    function transferFrom(
        address from,
        address to,
        uint256 tokenId
    ) public virtual override(ERC721, IERC721) {
        // Intentionally disable transfer by doing nothing.
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId
    ) public virtual override(ERC721, IERC721) {
        // Intentionally disable transfer by doing nothing.
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) public virtual override(ERC721, IERC721) {
        // Intentionally disable transfer by doing nothing.
    }
}
