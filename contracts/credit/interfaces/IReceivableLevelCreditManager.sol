// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditConfig, CreditLimit} from "../CreditStructs.sol";

interface IReceivableLevelCreditManager {
    function onlyPayer(address account, bytes32 creditHash) external view returns (address);
}
