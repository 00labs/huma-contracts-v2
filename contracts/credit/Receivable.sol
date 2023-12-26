// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC721EnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import {ERC721URIStorageUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import {ERC721BurnableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721BurnableUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {CountersUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/CountersUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Errors} from "../Errors.sol";
import {ReceivableStorage} from "./ReceivableStorage.sol";
import {IReceivable} from "./interfaces/IReceivable.sol";
import {ReceivableInfo, ReceivableState} from "./CreditStructs.sol";
import "hardhat/console.sol";

/**
 * @title RealWorldReceivable
 * @dev ERC721 tokens that represent off-chain payable receivables
 */
contract Receivable is
    IReceivable,
    ReceivableStorage,
    Initializable,
    ERC721Upgradeable,
    ERC721EnumerableUpgradeable,
    ERC721URIStorageUpgradeable,
    ERC721BurnableUpgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    using CountersUpgradeable for CountersUpgradeable.Counter;

    /**
     * @dev Emitted when the owner of a receivable calls the declarePayment function
     * @param from The address of the owner of the receivable
     * @param tokenId The ID of the receivable token
     * @param currencyCode The ISO 4217 currency code that the receivable is denominated in
     * @param amount The amount that was declared paid
     */
    event PaymentDeclared(
        address indexed from,
        uint256 indexed tokenId,
        uint16 currencyCode,
        uint256 amount
    );

    /**
     * @dev Emitted when a receivable is created
     * @param owner The address of the owner of the receivable
     * @param tokenId The ID of the receivable token
     * @param receivableAmount The total expected payment amount of the receivable
     * @param maturityDate The date at which the receivable becomes due
     * @param currencyCode The ISO 4217 currency code that the receivable is denominated in
     */
    event ReceivableCreated(
        address indexed owner,
        uint256 indexed tokenId,
        uint256 receivableAmount,
        uint64 maturityDate,
        uint16 currencyCode
    );

    /**
     * @dev Emitted when a receivable update is created
     * @param owner The address of the owner of the receivable
     * @param tokenId The ID of the newly created receivable update token
     * @param originalReceivableTokenId The ID of the original receivable token which is being updated
     */
    event ReceivableUpdateCreated(
        address indexed owner,
        uint256 indexed tokenId,
        uint256 indexed originalReceivableTokenId
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // _disableInitializers();
    }

    /**
     * @dev Initializer that sets the default admin and minter roles
     */
    function initialize() public initializer {
        // todo change the upgradability to be consistent with what we will use in v2
        __ERC721_init("Receivable", "REC");
        __ERC721Enumerable_init();
        __ERC721URIStorage_init();
        __ERC721Burnable_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _grantRole(UPGRADER_ROLE, msg.sender);
    }

    /// @inheritdoc IReceivable
    function createReceivable(
        uint16 currencyCode,
        uint96 receivableAmount,
        uint64 maturityDate,
        string memory uri
    ) public onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        tokenId = _tokenIdCounter.current();
        _tokenIdCounter.increment();
        _safeMint(msg.sender, tokenId);

        receivableInfoMap[tokenId] = ReceivableInfo(
            receivableAmount,
            uint64(block.timestamp),
            0, // paidAmount
            currencyCode,
            maturityDate,
            ReceivableState.Minted // Minted
        );
        creators[tokenId] = msg.sender;

        _setTokenURI(tokenId, uri);

        emit ReceivableCreated(msg.sender, tokenId, receivableAmount, maturityDate, currencyCode);
    }

    /// @inheritdoc IReceivable
    function createReceivableUpdate(
        uint256 originalReceivableTokenId,
        string memory uri
    ) public onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        if (
            msg.sender != ownerOf(originalReceivableTokenId) &&
            msg.sender != creators[originalReceivableTokenId]
        ) revert Errors.notReceivableOwnerOrCreator();
        ReceivableInfo storage originalReceivableInfo = receivableInfoMap[
            originalReceivableTokenId
        ];
        // Only non-update receivable tokens can be updated
        if (originalReceivableInfo.state == ReceivableState.Update) revert Errors.todo();

        tokenId = _tokenIdCounter.current();
        _tokenIdCounter.increment();
        _safeMint(msg.sender, tokenId);

        receivableInfoMap[tokenId] = ReceivableInfo(
            0,
            uint64(block.timestamp),
            0, // paidAmount
            0,
            0,
            ReceivableState.Update // All receivable updates use the Update state
        );
        receievableUpdatesMap[tokenId] = originalReceivableTokenId;
        creators[tokenId] = msg.sender;

        _setTokenURI(tokenId, uri);

        emit ReceivableUpdateCreated(msg.sender, tokenId, originalReceivableTokenId);
    }

    /// @inheritdoc IReceivable
    function declarePayment(uint256 tokenId, uint96 paymentAmount) external {
        if (paymentAmount == 0) revert Errors.zeroAmountProvided();
        if (msg.sender != ownerOf(tokenId) && msg.sender != creators[tokenId])
            revert Errors.notReceivableOwnerOrCreator();

        ReceivableInfo storage receivableInfo = receivableInfoMap[tokenId];
        if (receivableInfo.state == ReceivableState.Update) revert Errors.todo(); // Receivable updates cannot be paid

        receivableInfo.paidAmount += paymentAmount;

        if (receivableInfo.paidAmount >= receivableInfo.receivableAmount) {
            receivableInfo.state = ReceivableState.Paid;
        } else {
            assert(receivableInfo.paidAmount > 0);
            receivableInfo.state = ReceivableState.PartiallyPaid;
        }

        emit PaymentDeclared(msg.sender, tokenId, receivableInfo.currencyCode, paymentAmount);
    }

    /// @inheritdoc IReceivable
    function getReceivable(
        uint256 tokenId
    ) external view returns (ReceivableInfo memory receivable) {
        return receivableInfoMap[tokenId];
    }

    function approveOrRejectReceivable(uint256 tokenId, bool approved) external {
        if (getStatus(tokenId) == ReceivableState.Minted)
            if (approved) receivableInfoMap[tokenId].state = ReceivableState.Approved;
            else receivableInfoMap[tokenId].state = ReceivableState.Rejected;
        else revert Errors.todo();
    }

    /// @inheritdoc IReceivable
    function getStatus(uint256 tokenId) public view returns (ReceivableState) {
        return receivableInfoMap[tokenId].state;
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    // The following functions are overrides required by Solidity.
    // super calls functions from right-to-left in the inheritance hierarchy: https://solidity-by-example.org/inheritance/#multiple-inheritance-order
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId,
        uint256 batchSize
    ) internal override(ERC721Upgradeable, ERC721EnumerableUpgradeable) {
        super._beforeTokenTransfer(from, to, tokenId, batchSize);
    }

    function _burn(
        uint256 tokenId
    ) internal override(ERC721Upgradeable, ERC721URIStorageUpgradeable) {
        super._burn(tokenId);
    }

    function tokenURI(
        uint256 tokenId
    )
        public
        view
        override(ERC721Upgradeable, ERC721URIStorageUpgradeable)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(
        bytes4 interfaceId
    )
        public
        view
        override(
            ERC721Upgradeable,
            ERC721EnumerableUpgradeable,
            ERC721URIStorageUpgradeable,
            AccessControlUpgradeable
        )
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
