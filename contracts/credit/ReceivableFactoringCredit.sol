// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC721, IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {Credit} from "./Credit.sol";
import {ReceivableInput, CreditRecord} from "./CreditStructs.sol";
import {IReceivableFactoringCredit} from "./interfaces/IReceivableFactoringCredit.sol";
import {IReceivableFactoringCreditForContract} from "./interfaces/IReceivableFactoringCreditForContract.sol";
import {IReceivableLevelCreditManager} from "./interfaces/IReceivableLevelCreditManager.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {Errors} from "../Errors.sol";

contract ReceivableFactoringCredit is
    ERC165Upgradeable,
    Credit,
    IERC721Receiver,
    IReceivableFactoringCredit,
    IReceivableFactoringCreditForContract
{
    bytes32 public constant PAYER_ROLE = keccak256("PAYER");

    event ExtraFundsDispersed(address indexed receiver, uint256 amount);

    //TODO add events

    function drawdownWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external {
        poolConfig.onlyProtocolAndPoolOn();

        if (msg.sender != borrower) revert Errors.notBorrower();
        if (receivableId == 0) revert Errors.zeroReceivableIdProvided();
        if (amount == 0) revert Errors.zeroAmountProvided();

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        if (receivableAsset.ownerOf(receivableId) != borrower) revert Errors.todo();

        bytes32 creditHash = _getCreditHash(receivableId);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        receivableAsset.safeTransferFrom(borrower, address(this), receivableId);

        _drawdown(borrower, creditHash, amount);
    }

    function makePaymentWithReceivable(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower) revert Errors.notBorrower();
        if (receivableId == 0) revert Errors.zeroReceivableIdProvided();
        if (amount == 0) revert Errors.zeroAmountProvided();

        bytes32 creditHash = _getCreditHash(receivableId);
        creditManager.onlyCreditBorrower(creditHash, borrower);

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        if (receivableAsset.ownerOf(receivableId) != address(this)) revert Errors.todo();

        return _makePaymentWithReceivable(borrower, creditHash, amount);
    }

    function makePaymentWithReceivableForContract(
        uint256 receivableId,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff) {
        poolConfig.onlyProtocolAndPoolOn();
        if (receivableId == 0) revert Errors.zeroReceivableIdProvided();
        if (amount == 0) revert Errors.zeroAmountProvided();

        IERC721 receivableAsset = IERC721(poolConfig.receivableAsset());
        if (receivableAsset.ownerOf(receivableId) != address(this)) revert Errors.todo();

        bytes32 creditHash = _getCreditHash(receivableId);
        // only payer access control to prevent money laundering
        address borrower = IReceivableLevelCreditManager(address(creditManager)).onlyPayer(
            msg.sender,
            creditHash
        );

        return _makePaymentWithReceivable(borrower, creditHash, amount);
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
            emit ExtraFundsDispersed(borrower, disbursedAmount);
        }

        // Don't delete paid receivable
    }

    function getCreditRecord(uint256 receivableId) external view returns (CreditRecord memory) {
        bytes32 creditHash = _getCreditHash(receivableId);
        return getCreditRecord(creditHash);
    }

    function onERC721Received(
        address /*operator*/,
        address /*from*/,
        uint256 /*tokenId*/,
        bytes calldata /*data*/
    ) external virtual returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IReceivableFactoringCreditForContract).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function _getCreditHash(
        uint256 receivableId
    ) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), poolConfig.receivableAsset(), receivableId));
    }
}
