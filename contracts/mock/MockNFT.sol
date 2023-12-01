// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC721EnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import {ERC721URIStorageUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import {ERC721BurnableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721BurnableUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {CountersUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/CountersUpgradeable.sol";
import "../Errors.sol";

contract MockNFT is
    ERC721Upgradeable,
    ERC721EnumerableUpgradeable,
    ERC721URIStorageUpgradeable,
    ERC721BurnableUpgradeable,
    OwnableUpgradeable
{
    using CountersUpgradeable for CountersUpgradeable.Counter;

    CountersUpgradeable.Counter internal _tokenIdCounter;

    function initialize() public initializer {
        // todo change the upgradability to be consistent with what we will use in v2
        __ERC721_init("MockNFT", "MNFT");
        __ERC721Enumerable_init();
        __ERC721URIStorage_init();
        __ERC721Burnable_init();
        __Ownable_init();
    }

    function getCurrentTokenId() external view returns (uint256) {
        return _tokenIdCounter.current();
    }

    function payOwner(uint256 tokenId, uint256 amount) external {
        // IERC20(_tokenAddress).safeTransferFrom(msg.sender, payee, amount);
    }

    function mintNFT(
        address recipient,
        string memory tokenURI
    ) external returns (uint256 newItemId) {
        _tokenIdCounter.increment();
        newItemId = _tokenIdCounter.current();
        _mint(recipient, newItemId);
        _setTokenURI(newItemId, tokenURI);
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId,
        uint256 batchSize
    ) internal override(ERC721Upgradeable, ERC721EnumerableUpgradeable) {
        ERC721EnumerableUpgradeable._beforeTokenTransfer(from, to, tokenId, batchSize);
    }

    function _burn(
        uint256 tokenId
    ) internal override(ERC721Upgradeable, ERC721URIStorageUpgradeable) {
        ERC721URIStorageUpgradeable._burn(tokenId);
    }

    function tokenURI(
        uint256 tokenId
    )
        public
        view
        override(ERC721Upgradeable, ERC721URIStorageUpgradeable)
        returns (string memory)
    {
        return ERC721URIStorageUpgradeable.tokenURI(tokenId);
    }

    function supportsInterface(
        bytes4 interfaceId
    )
        public
        view
        override(ERC721Upgradeable, ERC721EnumerableUpgradeable, ERC721URIStorageUpgradeable)
        returns (bool)
    {
        return
            ERC721EnumerableUpgradeable.supportsInterface(interfaceId) ||
            ERC721URIStorageUpgradeable.supportsInterface(interfaceId);
    }
}
