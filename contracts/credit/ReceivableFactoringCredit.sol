// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC721, IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {Credit} from "./Credit.sol";
import {CreditRecord, DueDetail} from "./CreditStructs.sol";
import {IReceivableFactoringCredit} from "./interfaces/IReceivableFactoringCredit.sol";
import {IReceivablePayable} from "./interfaces/IReceivablePayable.sol";
import {IReceivableLevelCreditManager} from "./interfaces/IReceivableLevelCreditManager.sol";
import {Errors} from "../common/Errors.sol";

contract ReceivableFactoringCredit is
    ERC165Upgradeable,
    Credit,
    IERC721Receiver,
    IReceivableFactoringCredit,
    IReceivablePayable
{
    bytes32 public constant PAYER_ROLE = keccak256("PAYER");

    event ExtraFundsDisbursed(address indexed receiver, uint256 amount);

    event DrawdownMadeWithReceivable(
        address indexed borrower,
        uint256 indexed receivableId,
        uint256 amount,
        address by
    );

    event PaymentMadeWithReceivable(
        address indexed borrower,
        uint256 indexed receivableId,
        uint256 amount,
        address by
    );

    /// @inheritdoc IReceivableFactoringCredit
    function drawdownWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 netAmountToBorrower) {
        poolConfig.onlyProtocolAndPoolOn();

        if (msg.sender != borrower) revert Errors.BorrowerRequired();
        if (receivableId == 0) revert Errors.ZeroReceivableIdProvided();

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        if (receivableAsset.ownerOf(receivableId) != borrower)
            revert Errors.ReceivableOwnerRequired();

        bytes32 creditHash = _getCreditHash(receivableId);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        receivableAsset.safeTransferFrom(borrower, address(this), receivableId);

        netAmountToBorrower = _drawdown(borrower, creditHash, amount);

        emit DrawdownMadeWithReceivable(borrower, receivableId, amount, msg.sender);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function makePaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external virtual returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) revert Errors.BorrowerRequired();
        if (receivableId == 0) revert Errors.ZeroReceivableIdProvided();

        bytes32 creditHash = _getCreditHash(receivableId);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        if (receivableAsset.ownerOf(receivableId) != address(this))
            revert Errors.ReceivableOwnerRequired();

        (amountPaid, paidoff) = _makePaymentWithReceivable(borrower, creditHash, amount);
        emit PaymentMadeWithReceivable(borrower, receivableId, amount, msg.sender);
    }

    function onERC721Received(
        address /*operator*/,
        address /*from*/,
        uint256 /*tokenId*/,
        bytes calldata /*data*/
    ) external virtual returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @inheritdoc IReceivablePayable
    function makePaymentWithReceivableByPayer(
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (receivableId == 0) revert Errors.ZeroReceivableIdProvided();

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        if (receivableAsset.ownerOf(receivableId) != address(this))
            revert Errors.ReceivableOwnerRequired();

        bytes32 creditHash = _getCreditHash(receivableId);
        // Restrict access to only payers to prevent money laundering.
        address borrower = IReceivableLevelCreditManager(address(creditManager)).onlyPayer(
            msg.sender,
            creditHash
        );

        (amountPaid, paidoff) = _makePaymentWithReceivable(borrower, creditHash, amount);
        emit PaymentMadeWithReceivable(borrower, receivableId, amount, msg.sender);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function getNextBillRefreshDate(
        uint256 receivableId
    ) external view returns (uint256 refreshDate) {
        bytes32 creditHash = _getCreditHash(receivableId);
        return _getNextBillRefreshDate(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function getDueInfo(
        uint256 receivableId
    ) external view returns (CreditRecord memory cr, DueDetail memory dd) {
        bytes32 creditHash = _getCreditHash(receivableId);
        return _getDueInfo(creditHash);
    }

    /// @inheritdoc IReceivableFactoringCredit
    function getCreditRecord(uint256 receivableId) external view returns (CreditRecord memory) {
        bytes32 creditHash = _getCreditHash(receivableId);
        return getCreditRecord(creditHash);
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IReceivablePayable).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function _makePaymentWithReceivable(
        address borrower,
        bytes32 creditHash,
        uint256 amount
    ) internal returns (uint256 amountPaid, bool paidoff) {
        (amountPaid, paidoff, ) = _makePayment(borrower, creditHash, amount);
        if (amount > amountPaid && msg.sender != borrower) {
            uint256 disbursedAmount = amount - amountPaid;
            poolSafe.deposit(msg.sender, disbursedAmount);
            poolSafe.withdraw(borrower, disbursedAmount);
            emit ExtraFundsDisbursed(borrower, disbursedAmount);
        }

        // Don't delete paid receivable
    }

    function _getCreditHash(
        uint256 receivableId
    ) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), poolConfig.receivableAsset(), receivableId));
    }
}
