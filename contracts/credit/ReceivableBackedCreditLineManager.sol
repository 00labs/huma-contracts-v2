// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BorrowerLevelCreditManager} from "./BorrowerLevelCreditManager.sol";
import {ReceivableBackedCreditLineManagerStorage} from "./ReceivableBackedCreditLineManagerStorage.sol";
import {CreditConfig} from "./CreditStructs.sol";
import {Errors} from "../common/Errors.sol";
import {IReceivableBackedCreditLineManager} from "./interfaces/IReceivableBackedCreditLineManager.sol";
import {HUNDRED_PERCENT_IN_BPS} from "../common/SharedDefs.sol";
import {IReceivable} from "./interfaces/IReceivable.sol";
import {PoolConfig} from "../common/PoolConfig.sol";
import {CreditManager} from "./CreditManager.sol";

contract ReceivableBackedCreditLineManager is
    IReceivableBackedCreditLineManager,
    BorrowerLevelCreditManager,
    ReceivableBackedCreditLineManagerStorage
{
    event ReceivableApproved(
        address borrower,
        uint256 receivableId,
        uint256 receivableAmount,
        uint256 incrementalCredit,
        uint256 availableCredit
    );

    /// @inheritdoc IReceivableBackedCreditLineManager
    function approveReceivable(address borrower, uint256 receivableId) external {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != humaConfig.eaServiceAccount() && msg.sender != address(credit))
            revert Errors.notAuthorizedCaller();

        if (receivableId == 0) revert Errors.zeroReceivableIdProvided();
        if (receivableBorrowerMap[receivableId] != address(0)) {
            // If a receivable has been previously approved, then early return so that the operation
            // is idempotent. This makes it possible for a manually approved receivable to be used
            // for drawdown in a pool that has receivable auto-approval.
            return;
        }
        uint256 receivableAmount = receivableAsset.getReceivable(receivableId).receivableAmount;
        // Either the receivable does not exist, or the receivable has a zero amount.
        // We shouldn't approve either way.
        if (receivableAmount == 0) revert Errors.zeroReceivableAmount();

        bytes32 creditHash = getCreditHash(borrower);
        onlyCreditBorrower(creditHash, borrower);

        _approveReceivable(borrower, creditHash, receivableId, receivableAmount);
    }

    function _approveReceivable(
        address borrower,
        bytes32 creditHash,
        uint256 receivableId,
        uint256 receivableAmount
    ) internal {
        CreditConfig memory cc = getCreditConfig(creditHash);
        uint256 availableCredit = getAvailableCredit(creditHash);

        uint256 incrementalCredit = (cc.advanceRateInBps * receivableAmount) /
            HUNDRED_PERCENT_IN_BPS;
        availableCredit += incrementalCredit;
        if (availableCredit > cc.creditLimit) {
            revert Errors.creditLineExceeded();
        }
        _availableCredits[creditHash] = uint96(availableCredit);

        receivableBorrowerMap[receivableId] = borrower;

        emit ReceivableApproved(
            borrower,
            receivableId,
            receivableAmount,
            incrementalCredit,
            availableCredit
        );
    }

    /// @inheritdoc IReceivableBackedCreditLineManager
    function validateReceivable(address borrower, uint256 receivableId) external view {
        if (receivableBorrowerMap[receivableId] != borrower) revert Errors.receivableIdMismatch();
    }

    /// @inheritdoc IReceivableBackedCreditLineManager
    function decreaseCreditLimit(bytes32 creditHash, uint256 amount) external {
        if (msg.sender != address(credit)) revert Errors.notAuthorizedCaller();
        uint256 availableCredit = getAvailableCredit(creditHash);
        if (amount > availableCredit) revert Errors.creditLineExceeded();
        availableCredit -= amount;
        _availableCredits[creditHash] = uint96(availableCredit);
    }

    function getAvailableCredit(bytes32 creditHash) public view returns (uint256 availableCredit) {
        return _availableCredits[creditHash];
    }

    function _updatePoolConfigData(PoolConfig poolConfig) internal virtual override {
        CreditManager._updatePoolConfigData(poolConfig);

        address addr = address(poolConfig.receivableAsset());
        assert(addr != address(0));
        receivableAsset = IReceivable(addr);
    }
}
