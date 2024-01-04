// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC721EnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import {ERC721URIStorageUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import {ERC721BurnableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721BurnableUpgradeable.sol";
import {CountersUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/CountersUpgradeable.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IReceivableFactoringCreditForContract} from "../credit/interfaces/IReceivableFactoringCreditForContract.sol";

contract MockNFT is
    ERC721Upgradeable,
    ERC721EnumerableUpgradeable,
    ERC721URIStorageUpgradeable,
    ERC721BurnableUpgradeable
{
    using CountersUpgradeable for CountersUpgradeable.Counter;
    using ERC165Checker for address;
    using SafeERC20 for IERC20;

    address public tokenAddress;
    CountersUpgradeable.Counter internal _tokenIdCounter;

    function initialize(address _tokenAddress, address humaPoolSafe) public initializer {
        __ERC721_init("MockNFT", "MNFT");
        __ERC721Enumerable_init();
        __ERC721URIStorage_init();
        __ERC721Burnable_init();

        tokenAddress = _tokenAddress;
        IERC20(tokenAddress).safeApprove(humaPoolSafe, type(uint256).max);
    }

    function getCurrentTokenId() external view returns (uint256) {
        return _tokenIdCounter.current();
    }

    function payOwner(uint256 tokenId, uint256 amount) external {
        address owner = ownerOf(tokenId);
        if (owner.supportsInterface(type(IReceivableFactoringCreditForContract).interfaceId)) {
            IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), amount);
            IReceivableFactoringCreditForContract(owner).makePaymentWithReceivableByPayer(
                tokenId,
                amount
            );
        } else {
            IERC20(tokenAddress).safeTransferFrom(msg.sender, owner, amount);
        }
    }

    function mintNFT(
        address _recipient,
        string memory _tokenURI
    ) external returns (uint256 newItemId) {
        _tokenIdCounter.increment();
        newItemId = _tokenIdCounter.current();
        _mint(_recipient, newItemId);
        _setTokenURI(newItemId, _tokenURI);
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
