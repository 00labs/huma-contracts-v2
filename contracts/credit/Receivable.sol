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
     * @dev Emitted when a receivable metadata URI is updated
     * @param owner The address of the owner of the receivable
     * @param tokenId The ID of the newly created receivable update token
     * @param oldTokenURI The old metadata URI of the receivable
     * @param newTokenURI The new metadata URI of the receivable
     */
    event ReceivableMetadataUpdated(
        address indexed owner,
        uint256 indexed tokenId,
        string oldTokenURI,
        string newTokenURI
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

        // Start the token counter at 1
        _tokenIdCounter.increment();
    }

    /// @inheritdoc IReceivable
    function createReceivable(
        uint16 currencyCode,
        uint96 receivableAmount,
        uint64 maturityDate,
        string memory referenceId,
        string memory uri
    ) public onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        tokenId = _tokenIdCounter.current();

        if (bytes(referenceId).length > 0) {
            bytes32 referenceIdCreatorHash = getReferenceIdCreatorHash(referenceId, msg.sender);
            uint256 existingTokenId = referenceIdCreatorHashToTokenIdMap[referenceIdCreatorHash];
            if (_exists(existingTokenId))
                revert Errors.receivableReferenceIdFromCreatorAlreadyExists(); // Receivable with this hashed reference id already exists

            referenceIdCreatorHashToTokenIdMap[referenceIdCreatorHash] = tokenId;
        }

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
    function declarePayment(uint256 tokenId, uint96 paymentAmount) external {
        if (paymentAmount == 0) revert Errors.zeroAmountProvided();
        if (msg.sender != ownerOf(tokenId) && msg.sender != creators[tokenId])
            revert Errors.notReceivableOwnerOrCreator();

        ReceivableInfo storage receivableInfo = receivableInfoMap[tokenId];
        receivableInfo.paidAmount += paymentAmount;

        if (receivableInfo.paidAmount >= receivableInfo.receivableAmount) {
            receivableInfo.state = ReceivableState.Paid;
        } else {
            assert(receivableInfo.paidAmount > 0);
            receivableInfo.state = ReceivableState.PartiallyPaid;
        }

        emit PaymentDeclared(msg.sender, tokenId, receivableInfo.currencyCode, paymentAmount);
    }

    /**
     * @notice Updates the metadata URI of a receivable
     * @custom:access Only the owner or the original creator of the token can update the metadata URI
     * @param tokenId The ID of the receivable token
     * @param uri The new metadata URI of the receivable
     */
    function updateReceivableMetadata(uint256 tokenId, string memory uri) external {
        if (msg.sender != ownerOf(tokenId) && msg.sender != creators[tokenId])
            revert Errors.notReceivableOwnerOrCreator();

        string memory oldTokenURI = tokenURI(tokenId);
        _setTokenURI(tokenId, uri);

        emit ReceivableMetadataUpdated(msg.sender, tokenId, oldTokenURI, uri);
    }

    /// @inheritdoc IReceivable
    function getReceivable(
        uint256 tokenId
    ) external view returns (ReceivableInfo memory receivable) {
        return receivableInfoMap[tokenId];
    }

    /// @inheritdoc IReceivable
    function getStatus(uint256 tokenId) public view returns (ReceivableState) {
        return receivableInfoMap[tokenId].state;
    }

    /// @inheritdoc IReceivable
    function getReferenceIdCreatorHash(
        string memory referenceId,
        address creator
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(referenceId, creator));
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
        return
            interfaceId == type(IReceivable).interfaceId ||
            ERC721Upgradeable.supportsInterface(interfaceId) ||
            AccessControlUpgradeable.supportsInterface(interfaceId);
    }
}
